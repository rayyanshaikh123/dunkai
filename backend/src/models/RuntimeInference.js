import mongoose from 'mongoose';

const schema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  device: { type: mongoose.Schema.Types.ObjectId, ref: 'RuntimeDevice', required: true },
  jobId: { type: String, required: true },
  requestId: { type: String, required: true },
  requestHash: { type: String, required: true },
  status: { type: String, enum: ['pending', 'completed', 'failed'], default: 'pending' },
  response: { type: mongoose.Schema.Types.Mixed, default: null, select: false },
  httpStatus: { type: Number, default: 200 },
  attempt: { type: Number, default: 1 },
  retryAt: { type: Date, default: null },
  usage: { type: mongoose.Schema.Types.Mixed, default: null },
  expiresAt: { type: Date, required: true, index: { expireAfterSeconds: 0 } },
}, { timestamps: true });
schema.index({ jobId: 1, requestId: 1 }, { unique: true });
export const RuntimeInference = mongoose.model('RuntimeInference', schema);
