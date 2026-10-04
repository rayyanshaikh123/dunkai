import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import { env } from '../config/env.js';

export const AI_QUEUE_NAME = 'dunkai-ai';
let connection;
let queue;

export const redisConnection = () => {
  if (!env.redisUrl) throw new Error('REDIS_URL is required for durable AI jobs');
  connection ??= new IORedis(env.redisUrl, { maxRetriesPerRequest: null });
  return connection;
};

export const aiQueue = () => {
  queue ??= new Queue(AI_QUEUE_NAME, { connection: redisConnection() });
  return queue;
};

export const enqueueAiJob = async (jobId) => {
  await aiQueue().add('run', { jobId }, { jobId, removeOnComplete: 1000, removeOnFail: 1000 });
};
