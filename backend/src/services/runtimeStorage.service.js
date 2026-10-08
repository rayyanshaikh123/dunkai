import mongoose from 'mongoose';
import { BoardArtifact } from '../models/BoardArtifact.js';
import { AiJob } from '../models/AiJob.js';
import { ApiError } from '../utils/ApiError.js';

const quotaCollection = () => mongoose.connection.db.collection('runtimeStorageQuota');
const scopes = (user) => [{ id: 'global', limit: 350 * 1024 * 1024 }, { id: 'user:' + user, limit: 64 * 1024 * 1024 }];
async function ensureQuota(scope, user) {
  if (await quotaCollection().findOne({ _id: scope.id })) return;
  const filter = scope.id === 'global' ? {} : { 'metadata.user': String(user) };
  const total = await mongoose.connection.db.collection('runtimeArtifacts.files').aggregate([{ $match: filter }, { $group: { _id: null, bytes: { $sum: '$length' } } }]).next();
  try { await quotaCollection().insertOne({ _id: scope.id, bytes: total?.bytes || 0 }); } catch (error) { if (error.code !== 11000) throw error; }
}
export async function reserveArtifactBytes(user, bytes) {
  const limits = scopes(user);
  for (const scope of limits) await ensureQuota(scope, user);
  await mongoose.connection.transaction(async (session) => {
    for (const scope of limits) {
      const changed = await quotaCollection().updateOne({ _id: scope.id, bytes: { $lte: scope.limit - bytes } }, { $inc: { bytes } }, { session });
      if (!changed.modifiedCount) throw new ApiError(413, 'Artifact storage is full. Delete older projects before uploading another board.');
    }
  });
}
export async function releaseArtifactBytes(user, bytes) {
  await mongoose.connection.transaction(async (session) => {
    for (const scope of scopes(user)) await quotaCollection().updateOne({ _id: scope.id }, [{ $set: { bytes: { $max: [0, { $subtract: ['$bytes', bytes] }] } } }], { session });
  });
}
export async function deleteRuntimeArtifacts(filter) {
  // Cloud Space outputs use the same private GridFS store and quota ledger.
  const jobs = await AiJob.find(filter).select('jobId');
  await AiJob.updateMany({ ...filter, execution: 'local', status: { $in: ['queued', 'running', 'completing'] } }, { $set: { status: 'cancelled', error: 'The design was deleted' }, $unset: { payload: 1 } });
  const ids = jobs.map((job) => job.jobId);
  const bucket = new mongoose.mongo.GridFSBucket(mongoose.connection.db, { bucketName: 'runtimeArtifacts' });
  for await (const file of mongoose.connection.db.collection('runtimeArtifacts.files').find({ 'metadata.jobId': { $in: ids } })) {
    await bucket.delete(file._id);
    await releaseArtifactBytes(file.metadata.user, file.length);
  }
  await BoardArtifact.deleteMany({ jobId: { $in: ids } });
}
