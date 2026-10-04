import mongoose from 'mongoose';
import { env } from './env.js';

export const connectDatabase = async () => {
  mongoose.set('strictQuery', true);

  const options = {
    maxPoolSize: 50,
    minPoolSize: 5,
    serverSelectionTimeoutMS: 10000,
    socketTimeoutMS: 45000,
  };

  try {
    const conn = await mongoose.connect(env.mongoUri, options);
    if (env.billingEnabled) {
      const hello = await conn.connection.db.admin().command({ hello: 1 });
      if (!hello.setName && hello.msg !== 'isdbgrid') {
        throw new Error('Credit billing requires a MongoDB replica set or sharded cluster for transactions');
      }
      if (process.env.DUNKAI_WORKER !== 'true' && (!env.stripeSecretKey || !env.stripeWebhookSecret)) {
        throw new Error('Credit billing requires STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET');
      }
      if (!env.aiQueueEnabled || !env.redisUrl) {
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
