import { randomUUID } from 'node:crypto';
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';

/** Explicit opt-in cloud test database; never use the application's DB name. */
export async function connectTestDatabase() {
  const uri = process.env.DUNKAI_TEST_MONGO_URI;
  if (!uri) {
    const mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    await mongoose.connect(mongo.getUri());
    return async () => { await mongoose.disconnect(); await mongo.stop(); };
  }
  const name = 'dunkai_test_credits_' + randomUUID().replaceAll('-', '').slice(0, 16);
  await mongoose.connect(uri, { dbName: name, maxPoolSize: 10, serverSelectionTimeoutMS: 20000 });
  if (mongoose.connection.name !== name) throw new Error('Refusing tests outside the isolated test database');
  return async () => {
    try {
      if (mongoose.connection.name !== name || !name.startsWith('dunkai_test_credits_')) throw new Error('Refusing to drop a non-test database');
      await mongoose.connection.dropDatabase();
    } finally { await mongoose.disconnect(); }
  };
}
