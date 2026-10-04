import { env } from './env.js';
import { CREDIT_PACKS, CREDIT_TARIFF_VERSION, FREE_CHATS_PER_MONTH, TRIAL_CREDITS } from './credits.js';

/** Public, versioned INR offer. The backend remains the pricing authority. */
export const publicPlans = () => ({
  billingEnabled: env.billingEnabled,
  currency: 'INR',
  tariffVersion: CREDIT_TARIFF_VERSION,
  freeChatsPerMonth: FREE_CHATS_PER_MONTH,
  trialCredits: TRIAL_CREDITS,
  packs: Object.values(CREDIT_PACKS).map(({ id, credits, amountPaise }) => ({ id, credits, amountPaise })),
  rates: { chat: 2, pipeline: 30, board: 101, byokPipeline: 10, byokBoard: 20 },
});
