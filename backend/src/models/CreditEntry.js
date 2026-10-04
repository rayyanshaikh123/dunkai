import mongoose from 'mongoose';

const creditEntrySchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  jobId: { type: String, default: null },
  payment: { type: mongoose.Schema.Types.ObjectId, ref: 'Payment', default: null },
  kind: { type: String, required: true },
  availableTrialDelta: { type: Number, default: 0 },
  availablePaidDelta: { type: Number, default: 0 },
  reservedTrialDelta: { type: Number, default: 0 },
  reservedPaidDelta: { type: Number, default: 0 },
  idempotencyKey: { type: String, required: true, unique: true },
  tariffVersion: { type: Number, default: null },
}, { timestamps: true });

export const CreditEntry = mongoose.model('CreditEntry', creditEntrySchema);
