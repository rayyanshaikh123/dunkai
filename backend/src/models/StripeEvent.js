import mongoose from 'mongoose';

const stripeEventSchema = new mongoose.Schema({
  eventId: { type: String, required: true, unique: true },
  type: { type: String, required: true },
}, { timestamps: true });

export const StripeEvent = mongoose.model('StripeEvent', stripeEventSchema);
