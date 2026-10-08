import mongoose from 'mongoose';
import { env } from './env.js';
import { connectWithMongoDnsFallback } from './mongoDns.js';
import { Message } from '../models/Message.js';
import { RuntimeDevice } from '../models/RuntimeDevice.js';
import { RuntimePairing } from '../models/RuntimePairing.js';
import { RuntimeInference } from '../models/RuntimeInference.js';
import { Wallet } from '../models/Wallet.js';
import { AiCharge } from '../models/AiCharge.js';
import { CreditEntry } from '../models/CreditEntry.js';
import { Usage } from '../models/Usage.js';
import { AiJob } from '../models/AiJob.js';
import { BoardArtifact } from '../models/BoardArtifact.js';

export const connectDatabase = async () => {
  mongoose.set('strictQuery', true);

  const options = {
    maxPoolSize: 50,
    minPoolSize: 5,
    serverSelectionTimeoutMS: 10000,
    socketTimeoutMS: 45000,
  };

  try {
    const conn = await connectWithMongoDnsFallback(env.mongoUri, options, {
      connect: (uri, connectionOptions) => mongoose.connect(uri, connectionOptions),
      enabled: env.mongoDnsFallback,
    });
    // The unique replay index is part of the billing boundary: accepting
    // requests before it exists could run two concurrent Groq calls for one ID.
    if (env.localRuntimeEnabled || env.creditMeteringEnabled) {
      const models = [Message, AiJob, BoardArtifact, Wallet, AiCharge, CreditEntry, Usage];
      if (env.localRuntimeEnabled) models.push(RuntimeDevice, RuntimePairing, RuntimeInference);
      await Promise.all(models.map((model) => model.createIndexes()));
    }
    if (env.creditMeteringEnabled) {
      const hello = await conn.connection.db.admin().command({ hello: 1 });
      if (!hello.setName && hello.msg !== 'isdbgrid') {
        throw new Error('Credit billing requires a MongoDB replica set or sharded cluster for transactions');
      }
    }
    if (env.billingEnabled) {
      if (process.env.DUNKAI_WORKER !== 'true' && (!env.stripeSecretKey || !env.stripeWebhookSecret)) {
        throw new Error('Credit billing requires STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET');
      }
      if (!env.localRuntimeEnabled && (!env.aiQueueEnabled || !env.redisUrl)) {
        throw new Error('Credit billing requires AI_QUEUE_ENABLED=true and REDIS_URL');
      }
      if (env.isProduction && process.env.DUNKAI_WORKER !== 'true' && !env.emailHost) {
        throw new Error('Credit billing requires EMAIL_HOST for account verification and password reset');
      }
    }
    console.log(`MongoDB connected: ${conn.connection.host}/${conn.connection.name}`);
    return conn;
  } catch (error) {
    console.error('MongoDB connection error:', error.message);
    throw error;
  }
};

export const disconnectDatabase = async () => {
  await mongoose.disconnect();
  console.log('MongoDB disconnected');
};

export { mongoose };
