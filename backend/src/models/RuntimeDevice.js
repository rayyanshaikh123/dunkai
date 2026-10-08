import mongoose from 'mongoose';

const schema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  name: { type: String, required: true, maxlength: 100 },
  tokenHash: { type: String, required: true, unique: true, select: false },
  expiresAt: { type: Date, required: true },
  revokedAt: { type: Date, default: null },
  lastSeenAt: { type: Date, default: null },
  ready: { type: Boolean, default: false },
  preferred: { type: Boolean, default: true },
  mode: { type: String, enum: ['hosted', 'byok'], default: 'hosted' },
  activeJob: { type: String, default: null },
  capabilities: { type: mongoose.Schema.Types.Mixed, default: {} },
}, { timestamps: true });
export const RuntimeDevice = mongoose.model('RuntimeDevice', schema);
