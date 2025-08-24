import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { MongoClient, ObjectId } from 'mongodb';
import { Kafka } from 'kafkajs';
import { SiweMessage } from 'siwe';
import axios from 'axios';

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

// Mongo setup
const mongoClient = new MongoClient(MONGO_URL, { serverSelectionTimeoutMS: 10000 });
await mongoClient.connect();
const db = mongoClient.db('gas_monitor');
const usersCol = db.collection('users');
const reportsCol = db.collection('reports');
const reposCol = db.collection('repos');
const onchainCol = db.collection('onchain_metrics');

// Kafka setup
const kafka = new Kafka({ clientId: KAFKA_CLIENT_ID, brokers: [KAFKA_BROKER] });
const producer = kafka.producer();
await producer.connect();

// Memory store for nonces
const nonceStore = new Map();

function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
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

// Webhook endpoint stub for GitHub (PR events)
app.post('/webhooks/github', async (req, res) => {
  // In production validate signature header using GITHUB_WEBHOOK_SECRET
  const event = req.headers['x-github-event'];
  const payload = req.body;
  if (event === 'pull_request' && payload?.action === 'opened') {
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
  const cursor = reportsCol.find({ tenantId }).sort({ createdAt: -1 }).limit(100);
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

app.listen(PORT, () => {
  console.log(`API listening on :${PORT}`);
});