import mongoose from 'mongoose';

const schema = new mongoose.Schema({
  deviceCodeHash: { type: String, required: true, unique: true, select: false },
  userCodeHash: { type: String, required: true, unique: true, select: false },
  name: { type: String, required: true, maxlength: 100 },
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  device: { type: mongoose.Schema.Types.ObjectId, ref: 'RuntimeDevice', default: null },
  encryptedToken: { type: String, default: null, select: false },
  expiresAt: { type: Date, required: true, index: { expireAfterSeconds: 0 } },
}, { timestamps: true });
export const RuntimePairing = mongoose.model('RuntimePairing', schema);
