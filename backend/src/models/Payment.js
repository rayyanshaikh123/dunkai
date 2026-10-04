import mongoose from 'mongoose';

const paymentSchema = new mongoose.Schema({
  orderId: { type: String, required: true, unique: true },
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  packId: { type: String, required: true },
  credits: { type: Number, required: true },
  amountPaise: { type: Number, required: true },
  currency: { type: String, default: 'inr' },
  stripeSessionId: { type: String, sparse: true, unique: true },
  paymentIntentId: { type: String, default: null, index: true },
  reversedCredits: { type: Number, default: 0 },
  status: { type: String, enum: ['pending', 'paid', 'refunded', 'disputed'], default: 'pending' },
}, { timestamps: true });

export const Payment = mongoose.model('Payment', paymentSchema);
