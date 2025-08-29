import dotenv from 'dotenv';
import { Kafka } from 'kafkajs';
import { MongoClient } from 'mongodb';
import axios from 'axios';

dotenv.config();

const KAFKA_BROKER = process.env.KAFKA_BROKER || 'kafka:9092';
const KAFKA_CLIENT_ID = process.env.KAFKA_CLIENT_ID || 'consumer-service';
const MONGO_URL = process.env.MONGO_URL || 'mongodb://root:example@mongo:27017/?authSource=admin';

const kafka = new Kafka({ clientId: KAFKA_CLIENT_ID, brokers: [KAFKA_BROKER] });
const consumer = kafka.consumer({ groupId: 'gas-monitor-consumers' });

const mongoClient = new MongoClient(MONGO_URL, { serverSelectionTimeoutMS: 10000 });
await mongoClient.connect();
const db = mongoClient.db('gas_monitor');
const reportsCol = db.collection('reports');
const onchainCol = db.collection('onchain_metrics');

await consumer.connect();
await consumer.subscribe({ topic: 'gas-run-results', fromBeginning: false });
await consumer.subscribe({ topic: 'onchain-gas', fromBeginning: false });

console.log('Consumer started.');

await consumer.run({
  eachMessage: async ({ topic, message }) => {
    try {
      const value = message.value?.toString() || '{}';
      const payload = JSON.parse(value);
      if (topic === 'gas-run-results') {
        payload.createdAt = new Date();
        const result = await reportsCol.insertOne(payload);
        try {
          await axios.post(process.env.API_INTERNAL_URL || 'http://api:4000/internal/reports/new', {
            _id: result.insertedId,
            ...payload
          }, { timeout: 2000 });
        } catch (e) {
          // best effort
        }
      } else if (topic === 'onchain-gas') {
        payload.createdAt = new Date();
        await onchainCol.insertOne(payload);
        try {
          await axios.post(process.env.API_INTERNAL_URL || 'http://api:4000/internal/onchain/new', payload, { timeout: 2000 });
        } catch (e) {
          // best effort
        }
      }
    } catch (err) {
      console.error('Consumer error:', err);
    }
  }
});