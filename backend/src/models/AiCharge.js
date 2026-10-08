import mongoose from 'mongoose';

const aiChargeSchema = new mongoose.Schema({
  jobId: { type: String, required: true, unique: true },
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  action: { type: String, required: true },
  kind: { type: String, required: true },
  period: { type: String, required: true },
  byok: { type: Boolean, default: false },
  freeChat: { type: Boolean, default: false },
  chat: { type: mongoose.Schema.Types.ObjectId, ref: 'Chat' },
  freeDesign: { type: Boolean, default: false },
  freeDesignPeriod: String,
  freeDesignStep: String,
  quoteCredits: { type: Number, required: true },
  reserveTrial: { type: Number, default: 0 },
  reservePaid: { type: Number, default: 0 },
  debitedCredits: { type: Number, default: 0 },
  providerUsage: { type: [mongoose.Schema.Types.Mixed], default: [] },
  tariffVersion: { type: Number, required: true },
  status: { type: String, enum: ['reserved', 'completed', 'released'], default: 'reserved' },
}, { timestamps: true });

export const AiCharge = mongoose.model('AiCharge', aiChargeSchema);
