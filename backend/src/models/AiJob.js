import mongoose from 'mongoose';

const aiJobSchema = new mongoose.Schema({
  jobId: { type: String, required: true, unique: true },
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  project: { type: mongoose.Schema.Types.ObjectId, ref: 'Project', default: null, index: true },
  chat: { type: mongoose.Schema.Types.ObjectId, ref: 'Chat', default: null },
  action: { type: String, required: true },
  execution: { type: String, enum: ['cloud', 'local'], default: 'cloud', index: true },
  device: { type: mongoose.Schema.Types.ObjectId, ref: 'RuntimeDevice', default: null, index: true },
  mode: { type: String, enum: ['hosted', 'byok'], default: 'hosted' },
  leaseHash: { type: String, default: null, select: false },
  leaseUntil: { type: Date, default: null },
  eventSequence: { type: Number, default: 0 },
  progress: { type: mongoose.Schema.Types.Mixed, default: null },
  status: { type: String, enum: ['queued', 'running', 'completing', 'completed', 'failed', 'cancelled'], default: 'queued' },
  result: { type: mongoose.Schema.Types.Mixed, default: null },
  error: { type: String, default: null },
  payload: { type: mongoose.Schema.Types.Mixed, select: false, default: null },
}, { timestamps: true });

export const AiJob = mongoose.model('AiJob', aiJobSchema);
