import mongoose from 'mongoose';

/**
 * Metered usage, one document per user per calendar month (UTC).
 *
 * `hosted*` counters are what plan quotas are checked against: work paid for
 * with the operator's keys. `byok*` are recorded so a user can see what their
 * own keys did, and are never limited. Counters move with atomic $inc, so two
 * runs started at once cannot both squeeze under the same limit.
 */
const usageSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    period: { type: String, required: true }, // 'YYYY-MM'
    hostedMessages: { type: Number, default: 0 },
    hostedBoards: { type: Number, default: 0 },
    byokMessages: { type: Number, default: 0 },
    byokBoards: { type: Number, default: 0 },
    freeChatsUsed: { type: Number, default: 0 },
    // Hosted design chats, separate from the legacy per-message counter.
    freeDesignsUsed: { type: Number, default: 0 },
  },
  { timestamps: true }
);

usageSchema.index({ user: 1, period: 1 }, { unique: true });

export const Usage = mongoose.model('Usage', usageSchema);
