import mongoose from 'mongoose';

const walletSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
  trialAvailable: { type: Number, default: 0 },
  paidAvailable: { type: Number, default: 0 },
  trialReserved: { type: Number, default: 0 },
  paidReserved: { type: Number, default: 0 },
  trialGranted: { type: Boolean, default: false },
}, { timestamps: true });

export const Wallet = mongoose.model('Wallet', walletSchema);
