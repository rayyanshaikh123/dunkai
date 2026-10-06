import mongoose from 'mongoose';

// A short-lived replay record prevents the same browser request from calling
// Groq twice when an HTTP response is lost or Axios repeats it after refresh.
const browserInferenceRunSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  requestId: { type: String, required: true },
  requestHash: { type: String, required: true },
  status: { type: String, enum: ['pending', 'completed', 'failed'], default: 'pending' },
  result: { type: mongoose.Schema.Types.Mixed, default: null },
  expiresAt: { type: Date, required: true },
}, { timestamps: true });

browserInferenceRunSchema.index({ user: 1, requestId: 1 }, { unique: true });
browserInferenceRunSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const BrowserInferenceRun = mongoose.model('BrowserInferenceRun', browserInferenceRunSchema);
