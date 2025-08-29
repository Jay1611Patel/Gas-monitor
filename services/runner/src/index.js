import dotenv from "dotenv";
import { Kafka } from "kafkajs";
import fs from "fs";
import fse from "fs-extra";
import path from "path";
import os from "os";
import { spawn } from "child_process";
import simpleGit from "simple-git";

dotenv.config();

const KAFKA_BROKER = process.env.KAFKA_BROKER || "kafka:9092";
const KAFKA_CLIENT_ID = process.env.KAFKA_CLIENT_ID || "runner-service";
const WORKDIR_BASE = process.env.WORKDIR_BASE || "/tmp/repos";
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || "";

const kafka = new Kafka({ clientId: KAFKA_CLIENT_ID, brokers: [KAFKA_BROKER] });
const consumer = kafka.consumer({ groupId: "gas-monitor-runner" });
const producer = kafka.producer();

await consumer.connect();
await producer.connect();
await consumer.subscribe({ topic: "gas-run-requests", fromBeginning: false });

console.log("Runner started.");

function withTokenRemote(owner, repo) {
  if (!GITHUB_TOKEN) {
    return `https://github.com/${owner}/${repo}.git`;
  }
  return `https://${GITHUB_TOKEN}@github.com/${owner}/${repo}.git`;
}

function runCmd(cmd, args, cwd, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: "inherit",
      shell: false,
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} ${args.join(" ")} exited ${code}`));
    });
  });
}

function extractExecutionGas(report) {
  const results = [];

  // Loop through methods
  for (const method of Object.values(report.data.methods || {})) {
    if (method.executionGasAverage) {
      results.push({
        contract: method.contract,
        method: method.method,
        executionGasAverage: method.executionGasAverage,
      });
    }
  }

  // Loop through deployments
  for (const deploy of report.data.deployments || []) {
    if (deploy.executionGasAverage) {
      results.push({
        contract: deploy.name,
        method: "deployment",
        executionGasAverage: deploy.executionGasAverage,
      });
    }
  }

  return results;
}

async function findGasReport(repoDir) {
  const candidates = [
    path.join(repoDir, "gasReporterOutput.json"),
    path.join(repoDir, "gas-report.json"),
    path.join(repoDir, "artifacts", "gasReporterOutput.json"),
  ];

  for (const p of candidates) {
    console.log("Checking for report at", p);
    if (fs.existsSync(p)) {
      try {
        const content = fs.readFileSync(p, "utf8"); // log contents safely
        const out = JSON.parse(content); // return parsed JSON
        console.log(extractExecutionGas(out));
        return extractExecutionGas(out);
      } catch (err) {
        console.error("Failed to parse JSON from", p, err);
      }
    } else {
      console.log("File does not exist:", p);
    }
  }

  return null;
}

async function processRequest(req) {
  const { tenantId, owner, repo, branch, prNumber, reason } = req;
  const workdir = path.join(WORKDIR_BASE, `${owner}__${repo}__${Date.now()}`);
  await fse.ensureDir(workdir);
  const git = simpleGit();
  const remote = withTokenRemote(owner, repo);

  try {
    console.log("Cloning", remote);
    await git.clone(remote, workdir);
    const repoGit = simpleGit({ baseDir: workdir });
    if (branch) {
      await repoGit.checkout(branch);
    }
    const commitSha = await repoGit.revparse(['HEAD']);

    // Install dependencies
    const hasPackage = fs.existsSync(path.join(workdir, "package.json"));
    if (hasPackage) {
      const hasYarn = fs.existsSync(path.join(workdir, "yarn.lock"));
      const hasNpmLock = fs.existsSync(path.join(workdir, "package-lock.json"));

      if (hasYarn) {
        // Clean install with Yarn
        await runCmd("yarn", ["install", "--frozen-lockfile"], workdir);
      } else if (hasNpmLock) {
        // Clean install with npm ci
        await runCmd("npm", ["ci", "--no-audit", "--no-fund"], workdir);
      } else {
        // Fallback to npm install
        await runCmd("npm", ["install", "--no-audit", "--no-fund"], workdir);
      }
    }

    // Run hardhat tests with gas reporter
    // Expect repo config to emit gasReporterOutput.json
    try {
      await runCmd("npx", ["hardhat", "test", "--network", "hardhat"], workdir);
      console.log("Listing files in repo after tests:");
      console.log(
        fs.readdirSync(workdir, { withFileTypes: true }).map((d) => d.name)
      );
    } catch (e) {
      console.warn("Hardhat test failed:", e.message);
    }

    const report = await findGasReport(workdir);
    const result = {
      tenantId,
      owner,
      repo,
      branch,
      prNumber: prNumber || null,
      commitSha,
      reason,
      report: report || {
        note: "No gasReporterOutput.json found; ensure hardhat-gas-reporter is configured.",
      },
      createdAt: new Date().toISOString(),
    };

    await producer.send({
      topic: "gas-run-results",
      messages: [{ value: JSON.stringify(result) }],
    });
  } catch (err) {
    console.error("Runner error:", err);
    const errorPayload = {
      tenantId,
      owner,
      repo,
      branch,
      prNumber: prNumber || null,
      commitSha: null,
      reason,
      error: String(err),
      createdAt: new Date().toISOString(),
    };
    await producer.send({
      topic: "gas-run-results",
      messages: [{ value: JSON.stringify(errorPayload) }],
    });
  } finally {
    try {
      await fse.remove(workdir);
    } catch {}
  }
}

await consumer.run({
  eachMessage: async ({ topic, partition, message, heartbeat, pause }) => {
    const value = message.value?.toString();
    try {
      const payload = JSON.parse(value);
      await processRequest(payload);
      await consumer.commitOffsets([{ topic, partition, offset: (Number(message.offset) + 1).toString() }]);
    } catch (err) {
      console.error("Failed processing message", err);
    }
  },
});
