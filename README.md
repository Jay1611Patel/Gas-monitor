# Gas Cost Monitor (SaaS)

A SaaS-style monorepo that analyzes Ethereum smart contract gas usage end-to-end:
- SIWE login (wallet address is tenantId)
- Connect a GitHub repo and trigger a Hardhat gas run
- Kafka pipeline stores results in MongoDB
- React dashboard shows reports, compares PRs, and visualizes live on-chain gas usage
- Go poller streams on-chain gas per contract to Kafka
- Prometheus and Grafana visualize and alert on gas metrics

## Monorepo Structure

```
/apps
  /dashboard           # React + Vite + Tailwind
/services
  /api                 # Node/Express API (SIWE, repo connect, webhooks)
  /consumer            # Kafka consumer -> MongoDB persistence
  /runner              # Clones repo, runs Hardhat tests, produces gas results
  /poller              # Go poller publishing on-chain gas metrics
/docker-compose.yml
```

## Prerequisites

- Docker and Docker Compose
- A GitHub personal access token (classic) with repo read access (for private repos). Optional for public repos.
- An Ethereum RPC URL (e.g., from Alchemy/Infura/anvil) for the Go poller

## Environment Variables

Each service has an `.env` file you can edit before running. Defaults work for local compose, except where noted.

- services/api/.env
```
PORT=4000
MONGO_URL=mongodb://root:example@mongo:27017/?authSource=admin
JWT_SECRET=devsecretjwt
KAFKA_BROKER=kafka:9092
KAFKA_CLIENT_ID=api-service
ETH_RPC_URL=
# Optional GitHub App integration
GITHUB_APP_ID=
GITHUB_PRIVATE_KEY_BASE64=
GITHUB_WEBHOOK_SECRET=
GITHUB_APP_INSTALLATION_ID=
```

- services/consumer/.env
```
KAFKA_BROKER=kafka:9092
KAFKA_CLIENT_ID=consumer-service
MONGO_URL=mongodb://root:example@mongo:27017/?authSource=admin
```

- services/runner/.env
```
KAFKA_BROKER=kafka:9092
KAFKA_CLIENT_ID=runner-service
WORKDIR_BASE=/tmp/repos
GITHUB_TOKEN= # optional for public repos, required for private
```

- services/poller/.env
```
KAFKA_BROKER=kafka:9092
KAFKA_TOPIC=onchain-gas
ETH_RPC_URL= # e.g. https://eth-mainnet.g.alchemy.com/v2/KEY or http://anvil:8545
CONTRACT_ADDRESSES= # comma-separated contract addresses to monitor (lowercase)
TENANT_ID= # wallet address or tenant id to attribute data to
```

- apps/dashboard/.env
```
VITE_API_BASE=http://localhost:4000
```

## Quick Start

1) Build and start everything

```bash
cd /workspace
docker compose build --no-cache
docker compose up -d
```

Services:
- API: http://localhost:4000
- Dashboard: http://localhost:5173
- Mongo Express: http://localhost:8081 (user/pass: root/example)
- Kafka: kafka:9092 (internal)
- Prometheus: http://localhost:9090
- Grafana: http://localhost:3000 (admin/admin)
  - Prometheus data is persisted to a Docker volume so dashboards retain history across restarts.

2) Open the dashboard

- Go to http://localhost:5173
- Click "Connect Wallet" and sign the SIWE message in MetaMask
  - Your wallet address becomes `tenantId`

3) Connect a GitHub repo

- Enter `owner` and `repo` and click "Connect & Run"
- This enqueues a message on `gas-run-requests`
- Runner clones the repo, installs deps, runs `npx hardhat test`
  - Ensure the repo is configured with `hardhat-gas-reporter` to output `gasReporterOutput.json` at repo root or in `artifacts/`
- Runner publishes results to `gas-run-results`
- Consumer writes to MongoDB
- API exposes `/reports` and the dashboard lists new reports

4) Compare reports visually

- Use the dropdowns to select two latest reports; the app renders bar charts for Left vs Right averages and Delta.
- In Grafana, open the "PR / Branch Comparison" dashboard to compare branches/PRs with filters.

5) Live on-chain gas

- Configure `services/poller/.env`:
  - `ETH_RPC_URL`
  - `TENANT_ID` (your wallet address — used to scope watches and metrics)
- Start poller only:

```bash
docker compose up -d --build poller
```

- In the dashboard:
  - Add a watched contract via the On-chain section (Watch button) — no need to edit env vars
  - Your watches are stored per-tenant and picked up by the Go poller dynamically
  - Click "Load" to fetch and visualize recent `gasUsed` per transaction

How the Go Poller works
- On start, it reads `ETH_RPC_URL` and `TENANT_ID`, then bootstraps watched addresses from the API: `GET /internal/onchain/watches?tenantId=<TENANT_ID>`.
- It consumes Kafka topic `onchain-watch-requests` to add/remove watched contracts in real time.
- It streams `gasUsed` for transactions hitting watched contracts to Kafka topic `onchain-gas`.
- The consumer persists to Mongo and posts to the API, which updates Prometheus metrics (`onchain_gas_used_*`).

## GitHub App (Optional)

You can integrate a GitHub App to receive PR webhooks and trigger runs automatically.
- Create a GitHub App with permissions for Pull Requests and Metadata
- Set the webhook URL to `http://<your_host_or_tunnel>:4000/webhooks/github`
- Fill the API `.env` GitHub variables
- On PR opened, the API will enqueue a run for that branch

Note: This template does not post PR comments. You can extend the API with GitHub REST calls using the App installation token to post Markdown tables with regressions.

## Hardhat Gas Reporter Setup (in target repos)

In the repo you connect, add:

```bash
npm i --save-dev hardhat hardhat-gas-reporter
```

In `hardhat.config.js`:

```js
require('hardhat-gas-reporter');
module.exports = {
  gasReporter: {
    enabled: true,
    outputJSON: true,
    outputFile: 'gasReporterOutput.json',
  },
};
```

Ensure `npx hardhat test` succeeds locally.

## Grafana Dashboards

- Access: http://localhost:3000 (admin/admin)
- Dashboards:
  - Global Overview: time series of avg gas, distribution histogram, and top contracts table.
  - PR / Branch Comparison: select two branches/PRs; shows overlapped time series and top deltas.
  - Contract/Method Drilldown: pick contract+method; shows trends over commits and distributions.

Filters
- `owner`, `repo`, `branch`, `contract`, `method` are available as template variables.
- Use regex like `.*` to see all or exact names to filter.

Interpreting Metrics
- `gas_execution_average` is a gauge labeled by tenant/repo/branch/contract/method/prNumber/commitSha set on each new report.
- `gas_execution_histogram`/`_summary` enable p50/p95/p99 and histograms over time.
- On-chain: `onchain_gas_used_histogram`/`_summary` for live gasUsed per tx per contract.

Persistence
- Prometheus TSDB is persisted in the `prometheus_data` volume with 90d retention, so Grafana retains history after restarts.

## Health and Troubleshooting

- View logs
```bash
docker compose logs -f api consumer runner poller frontend
```

- Verify Kafka topics (auto-created): `gas-run-requests`, `gas-run-results`, `onchain-gas`
- Check Mongo: http://localhost:8081 (db: `gas_monitor`, collections: `users`, `repos`, `reports`, `onchain_metrics`)
- Runner needs git and build tools (provided). Private repos require `GITHUB_TOKEN`.
- If gas outputs are missing, confirm the repo writes `gasReporterOutput.json`.

## Security Notes

- JWT_SECRET is for local dev only. Change in prod.
- Validate GitHub webhook signatures in production using `GITHUB_WEBHOOK_SECRET`.
- Use proper Kafka auth and TLS in production. This compose uses PLAINTEXT for simplicity.
- Use a dedicated RPC and rate limiting for the poller.

## Extending

- Add regression detection in consumer or API when inserting reports (compare to previous main branch report)
- Post GitHub PR comments via App installation token
- Add USD cost estimation by fetching ETH price
- Add multi-chain pollers and tenants

## Full Teardown

```bash
docker compose down -v
```