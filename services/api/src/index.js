import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { MongoClient, ObjectId } from 'mongodb';
import { Kafka } from 'kafkajs';
import { SiweMessage } from 'siwe';
import axios from 'axios';
import client from 'prom-client';

dotenv.config();

const app = express();
app.use(cors({
  origin: ['http://localhost:5173', 'http://frontend:5173'], // allow dev host & Docker frontend
  credentials: true,
}));
app.use(express.json({ limit: '2mb' }));

const PORT = process.env.PORT || 4000;
const JWT_SECRET = process.env.JWT_SECRET || 'devsecretjwt';
const MONGO_URL = process.env.MONGO_URL || 'mongodb://root:example@mongo:27017/?authSource=admin';
const KAFKA_BROKER = process.env.KAFKA_BROKER || 'kafka:9092';
const KAFKA_CLIENT_ID = process.env.KAFKA_CLIENT_ID || 'api-service';

// Prometheus metrics
const register = new client.Registry();
client.collectDefaultMetrics({ register });
const gasGauge = new client.Gauge({
  name: 'gas_execution_average',
  help: 'Average execution gas per contract/method',
  labelNames: ['tenantId', 'owner', 'repo', 'branch', 'contract', 'method', 'prNumber', 'commitSha']
});
register.registerMetric(gasGauge);

const gasHistogram = new client.Histogram({
  name: 'gas_execution_histogram',
  help: 'Histogram of execution gas per contract/method',
  buckets: [10000, 30000, 50000, 70000, 90000, 110000, 150000, 200000, 300000, 500000, 1000000],
  labelNames: ['tenantId', 'owner', 'repo', 'branch', 'contract', 'method', 'prNumber', 'commitSha']
});
register.registerMetric(gasHistogram);

const gasSummary = new client.Summary({
  name: 'gas_execution_summary',
  help: 'Summary of execution gas per contract/method',
  percentiles: [0.5, 0.9, 0.95, 0.99],
  labelNames: ['tenantId', 'owner', 'repo', 'branch', 'contract', 'method', 'prNumber', 'commitSha']
});
register.registerMetric(gasSummary);

// On-chain gas metrics
const onchainHistogram = new client.Histogram({
  name: 'onchain_gas_used_histogram',
  help: 'Histogram of on-chain gasUsed per transaction per contract',
  buckets: [21000, 50000, 70000, 90000, 120000, 200000, 500000, 1000000, 5000000],
  labelNames: ['tenantId', 'contract', 'methodSignature']
});
register.registerMetric(onchainHistogram);

const onchainSummary = new client.Summary({
  name: 'onchain_gas_used_summary',
  help: 'Summary of on-chain gasUsed per transaction per contract',
  percentiles: [0.5, 0.9, 0.95, 0.99],
  labelNames: ['tenantId', 'contract', 'methodSignature']
});
register.registerMetric(onchainSummary);

const onchainPriceHistogram = new client.Histogram({
  name: 'onchain_effective_gas_price_gwei_histogram',
  help: 'Histogram of effective gas price (gwei) per tx',
  buckets: [1, 5, 10, 20, 50, 100, 200, 400],
  labelNames: ['tenantId', 'contract']
});
register.registerMetric(onchainPriceHistogram);

const onchainBaseFeeHistogram = new client.Histogram({
  name: 'onchain_base_fee_gwei_histogram',
  help: 'Histogram of base fee (gwei) per block',
  buckets: [1, 5, 10, 20, 50, 100, 200, 400],
  labelNames: ['tenantId']
});
register.registerMetric(onchainBaseFeeHistogram);

const onchainPriorityFeeHistogram = new client.Histogram({
  name: 'onchain_priority_fee_gwei_histogram',
  help: 'Histogram of priority fee (gwei) per tx',
  buckets: [0.1, 0.5, 1, 2, 5, 10, 20, 50],
  labelNames: ['tenantId', 'contract']
});
register.registerMetric(onchainPriorityFeeHistogram);

const onchainTxCostEthHistogram = new client.Histogram({
  name: 'onchain_tx_cost_eth_histogram',
  help: 'Histogram of transaction cost in ETH',
  buckets: [0.00001, 0.00005, 0.0001, 0.0005, 0.001, 0.005, 0.01],
  labelNames: ['tenantId', 'contract']
});
register.registerMetric(onchainTxCostEthHistogram);

const onchainTxCount = new client.Counter({
  name: 'onchain_tx_count',
  help: 'Count of on-chain transactions per contract/method',
  labelNames: ['tenantId', 'contract', 'methodSignature']
});
register.registerMetric(onchainTxCount);

const onchainGasTotal = new client.Counter({
  name: 'onchain_gas_total',
  help: 'Total gas used per contract/method',
  labelNames: ['tenantId', 'contract', 'methodSignature']
});
register.registerMetric(onchainGasTotal);

const ethPriceUsd = new client.Gauge({
  name: 'eth_price_usd',
  help: 'ETH price in USD (Coingecko)'
});
register.registerMetric(ethPriceUsd);

// SSE clients keyed by tenantId
const tenantToClients = new Map();

// Mongo setup
const mongoClient = new MongoClient(MONGO_URL, { serverSelectionTimeoutMS: 10000 });
await mongoClient.connect();
const db = mongoClient.db('gas_monitor');
const usersCol = db.collection('users');
const reportsCol = db.collection('reports');
const reposCol = db.collection('repos');
const onchainCol = db.collection('onchain_metrics');
const watchesCol = db.collection('onchain_watches');

// Kafka setup
const kafka = new Kafka({ clientId: KAFKA_CLIENT_ID, brokers: [KAFKA_BROKER] });
const producer = kafka.producer();
await producer.connect();

// Memory store for nonces
const nonceStore = new Map();

function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization || '';
  let token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token && req.query && req.query.token) {
    token = String(req.query.token);
  }
  if (!token) return res.status(401).json({ error: 'Missing token' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = payload;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

// SIWE: nonce
app.post('/auth/nonce', async (req, res) => {
  const nonce = crypto.randomBytes(16).toString('hex');
  const { address } = req.body || {};
  if (!address) return res.status(400).json({ error: 'Missing address' });
  nonceStore.set(address.toLowerCase(), nonce);
  res.json({ nonce });
});

// SIWE: verify
app.post('/auth/verify', async (req, res) => {
  try {
    const { message, signature } = req.body;
    const siweMessage = new SiweMessage(message);
    const fields = await siweMessage.verify({ signature });
    const address = fields.data.address.toLowerCase();
    const expectedNonce = nonceStore.get(address);
    if (!expectedNonce || expectedNonce !== fields.data.nonce) {
      return res.status(400).json({ error: 'Invalid nonce' });
    }
    nonceStore.delete(address);

    const tenantId = address; // wallet address as tenantId
    await usersCol.updateOne(
      { tenantId },
      { $setOnInsert: { tenantId, createdAt: new Date() } },
      { upsert: true }
    );

    const token = jwt.sign({ tenantId, address }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, tenantId, address });
  } catch (err) {
    res.status(400).json({ error: 'SIWE verification failed', details: String(err) });
  }
});

app.get('/me', authMiddleware, async (req, res) => {
  const user = await usersCol.findOne({ tenantId: req.user.tenantId });
  res.json({ user });
});

// Connect a GitHub repo (simple record + schedule initial run)
app.post('/repos/connect', authMiddleware, async (req, res) => {
  const { owner, repo, defaultBranch = 'main' } = req.body || {};
  if (!owner || !repo) return res.status(400).json({ error: 'owner and repo required' });
  const record = {
    tenantId: req.user.tenantId,
    owner,
    repo,
    defaultBranch,
    createdAt: new Date(),
  };
  await reposCol.updateOne(
    { tenantId: record.tenantId, owner, repo },
    { $set: record },
    { upsert: true }
  );

  // enqueue initial run
  await producer.send({
    topic: 'gas-run-requests',
    messages: [
      {
        key: `${owner}/${repo}`,
        value: JSON.stringify({
          tenantId: record.tenantId,
          owner,
          repo,
          branch: defaultBranch,
          reason: 'initial-connect'
        })
      }
    ]
  });

  res.json({ ok: true });
});

// List connected repos and branches for a tenant
app.get('/repos', authMiddleware, async (req, res) => {
  const tenantId = req.user.tenantId;
  const repos = await reposCol.find({ tenantId }).toArray();
  res.json({ repos });
});

// List branches seen in reports for a given repo
app.get('/branches', authMiddleware, async (req, res) => {
  const tenantId = req.user.tenantId;
  const { owner, repo } = req.query;
  if (!owner || !repo) return res.status(400).json({ error: 'owner and repo required' });
  const branches = await reportsCol.distinct('branch', { tenantId, owner, repo });
  res.json({ branches });
});

// Webhook endpoint stub for GitHub (PR events)
app.post('/webhooks/github', async (req, res) => {
  // In production validate signature header using GITHUB_WEBHOOK_SECRET
  const event = req.headers['x-github-event'];
  const payload = req.body;
  if (event === 'pull_request' && (payload?.action === 'opened' || payload?.action === 'synchronize' || payload?.action === 'reopened')) {
    const owner = payload.repository.owner.login;
    const repo = payload.repository.name;
    const prNumber = payload.number;
    const branch = payload.pull_request.head.ref;
    const tenant = await reposCol.findOne({ owner, repo });
    if (tenant) {
      await producer.send({
        topic: 'gas-run-requests',
        messages: [
          { value: JSON.stringify({ tenantId: tenant.tenantId, owner, repo, branch, prNumber, reason: 'pr-opened' }) }
        ]
      });
    }
  }
  res.json({ ok: true });
});

// Reports query
app.get('/reports', authMiddleware, async (req, res) => {
  const tenantId = req.user.tenantId;
  const { owner, repo, branch, limit = 100 } = req.query || {};
  const q = { tenantId };
  if (owner) q.owner = owner;
  if (repo) q.repo = repo;
  if (branch) q.branch = branch;
  const cursor = reportsCol.find(q).sort({ createdAt: -1 }).limit(Number(limit) || 100);
  const items = await cursor.toArray();
  res.json({ items });
});

app.get('/reports/pr/:prNumber', authMiddleware, async (req, res) => {
  const tenantId = req.user.tenantId;
  const prNumber = Number(req.params.prNumber);
  const items = await reportsCol.find({ tenantId, prNumber }).sort({ createdAt: -1 }).toArray();
  res.json({ items });
});

app.get('/reports/compare', authMiddleware, async (req, res) => {
  const tenantId = req.user.tenantId;
  const { leftId, rightId } = req.query;
  if (!leftId || !rightId) return res.status(400).json({ error: 'leftId and rightId required' });
  const left = await reportsCol.findOne({ tenantId, _id: new ObjectId(String(leftId)) });
  const right = await reportsCol.findOne({ tenantId, _id: new ObjectId(String(rightId)) });
  res.json({ left, right });
});

// On-chain metrics
app.get('/onchain/:address', authMiddleware, async (req, res) => {
  const tenantId = req.user.tenantId;
  const address = String(req.params.address).toLowerCase();
  const items = await onchainCol.find({ tenantId, contract: address }).sort({ blockNumber: -1 }).limit(500).toArray();
  res.json({ items });
});

// On-chain dynamic watch management
app.get('/onchain/watches', authMiddleware, async (req, res) => {
  const tenantId = req.user.tenantId;
  const items = await watchesCol.find({ tenantId }).sort({ createdAt: -1 }).toArray();
  res.json({ items });
});

app.post('/onchain/watches', authMiddleware, async (req, res) => {
  const tenantId = req.user.tenantId;
  const { contract } = req.body || {};
  if (!contract) return res.status(400).json({ error: 'contract required' });
  const address = String(contract).toLowerCase();
  await watchesCol.updateOne(
    { tenantId, contract: address },
    { $set: { tenantId, contract: address, createdAt: new Date() } },
    { upsert: true }
  );
  // publish watch add
  await producer.send({ topic: 'onchain-watch-requests', messages: [{ value: JSON.stringify({ tenantId, contract: address, action: 'add' }) }]});
  res.json({ ok: true });
});

app.delete('/onchain/watches/:contract', authMiddleware, async (req, res) => {
  const tenantId = req.user.tenantId;
  const contract = String(req.params.contract).toLowerCase();
  await watchesCol.deleteOne({ tenantId, contract });
  // publish watch remove
  await producer.send({ topic: 'onchain-watch-requests', messages: [{ value: JSON.stringify({ tenantId, contract, action: 'remove' }) }]});
  res.json({ ok: true });
});

// Internal: list watches for a tenant
app.get('/internal/onchain/watches', async (req, res) => {
  const { tenantId } = req.query || {};
  if (!tenantId) return res.status(400).json({ error: 'tenantId required' });
  const items = await watchesCol.find({ tenantId: String(tenantId).toLowerCase() }).toArray();
  res.json({ items });
});

// SSE stream for new reports per tenant
app.get('/reports/stream', authMiddleware, async (req, res) => {
  const tenantId = req.user.tenantId;
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders && res.flushHeaders();

  const client = res;
  const list = tenantToClients.get(tenantId) || new Set();
  list.add(client);
  tenantToClients.set(tenantId, list);

  client.write(`event: heartbeat\n`);
  client.write(`data: {"ok":true}\n\n`);

  req.on('close', () => {
    const set = tenantToClients.get(tenantId);
    if (set) {
      set.delete(client);
      if (set.size === 0) tenantToClients.delete(tenantId);
    }
  });
});

// Prometheus metrics endpoint
app.get('/metrics', async (_req, res) => {
  try {
    res.set('Content-Type', register.contentType);
    res.end(await register.metrics());
  } catch (err) {
    res.status(500).end(String(err));
  }
});

// Internal hook for new report notification (called by consumer)
app.post('/internal/reports/new', async (req, res) => {
  try {
    const doc = req.body || {};
    const tenantId = doc.tenantId;
    const reportArray = Array.isArray(doc.report) ? doc.report : null;
    if (reportArray) {
      for (const item of reportArray) {
        const labels = {
          tenantId,
          owner: doc.owner,
          repo: doc.repo,
          branch: doc.branch || '',
          contract: item.contract || 'unknown',
          method: item.method || 'unknown',
          prNumber: String(doc.prNumber ?? ''),
          commitSha: String(doc.commitSha ?? '')
        };
        const value = Number(item.executionGasAverage) || 0;
        gasGauge.set(labels, value);
        gasHistogram.observe(labels, value);
        gasSummary.observe(labels, value);
      }
    }
    const set = tenantToClients.get(tenantId);
    if (set && set.size > 0) {
      const payload = JSON.stringify({
        type: 'new-report',
        report: {
          _id: doc._id,
          owner: doc.owner,
          repo: doc.repo,
          branch: doc.branch,
          prNumber: doc.prNumber,
          createdAt: doc.createdAt,
        }
      });
      for (const r of set) {
        try { r.write(`event: report\n`); r.write(`data: ${payload}\n\n`); } catch {}
      }
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// Internal hook for on-chain gas notification (called by consumer)
app.post('/internal/onchain/new', async (req, res) => {
  try {
    const doc = req.body || {};
    const baseLabels = { tenantId: String(doc.tenantId || '') };
    const txLabels = { tenantId: String(doc.tenantId || ''), contract: String(doc.contract || ''), methodSignature: String(doc.methodSignature || '') };
    const gasUsed = Number(doc.gasUsed) || 0;
    onchainHistogram.observe(txLabels, gasUsed);
    onchainSummary.observe(txLabels, gasUsed);
    onchainTxCount.inc(txLabels);
    onchainGasTotal.inc(txLabels, gasUsed);
    if (doc.effectiveGasPriceGwei != null) onchainPriceHistogram.observe({ tenantId: txLabels.tenantId, contract: txLabels.contract }, Number(doc.effectiveGasPriceGwei));
    if (doc.baseFeeGwei != null) onchainBaseFeeHistogram.observe(baseLabels, Number(doc.baseFeeGwei));
    if (doc.priorityFeeGwei != null) onchainPriorityFeeHistogram.observe({ tenantId: txLabels.tenantId, contract: txLabels.contract }, Number(doc.priorityFeeGwei));
    if (doc.costEth != null) onchainTxCostEthHistogram.observe({ tenantId: txLabels.tenantId, contract: txLabels.contract }, Number(doc.costEth));
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.listen(PORT, () => {
  console.log(`API listening on :${PORT}`);
});

// Backfill Prometheus metrics from recent Mongo reports on startup
;(async function backfillMetrics() {
  try {
    const cursor = reportsCol.find({ report: { $type: 'array' } }).sort({ createdAt: -1 }).limit(1000);
    const items = await cursor.toArray();
    for (const doc of items) {
      const tenantId = doc.tenantId;
      if (!Array.isArray(doc.report)) continue;
      for (const item of doc.report) {
        const labels = {
          tenantId,
          owner: doc.owner,
          repo: doc.repo,
          branch: doc.branch || '',
          contract: item.contract || 'unknown',
          method: item.method || 'unknown',
          prNumber: String(doc.prNumber ?? ''),
          commitSha: String(doc.commitSha ?? ''),
        };
        const value = Number(item.executionGasAverage) || 0;
        gasGauge.set(labels, value);
        gasHistogram.observe(labels, value);
        gasSummary.observe(labels, value);
      }
    }
    console.log(`Backfilled metrics from ${items.length} reports.`);
  } catch (err) {
    console.error('Backfill metrics error:', err);
  }
})();