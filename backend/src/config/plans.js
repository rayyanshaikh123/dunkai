import { env } from './env.js';
import { CREDIT_PACKS, CREDIT_TARIFF_VERSION, FREE_CHATS_PER_MONTH, TRIAL_CREDITS } from './credits.js';

/** Public, versioned INR offer. The backend remains the pricing authority. */
export const publicPlans = () => ({
  billingEnabled: env.billingEnabled,
  billingMode: !env.billingEnabled ? 'disabled' : env.stripeSecretKey.startsWith('sk_live_') ? 'live' : 'test',
  meteringEnabled: env.creditMeteringEnabled,
  localRuntimeEnabled: env.localRuntimeEnabled,
  currency: 'INR',
  tariffVersion: CREDIT_TARIFF_VERSION,
  freeChatsPerMonth: FREE_CHATS_PER_MONTH,
  freeAllowanceUnit: env.localRuntimeEnabled ? 'model_call' : 'design_chat',
  freePipelineRunsPerChat: env.localRuntimeEnabled ? 0 : 1,
  freeBoardRunsPerChat: env.localRuntimeEnabled ? 0 : 1,
  trialCredits: env.localRuntimeEnabled ? 0 : TRIAL_CREDITS,
  packs: Object.values(CREDIT_PACKS).map(({ id, credits, amountPaise }) => ({ id, credits, amountPaise })),
  rates: env.localRuntimeEnabled
    ? { chat: 2, inference: 2, pipeline: 0, board: 0, byokPipeline: 0, byokBoard: 0 }
    : { chat: 2, inference: null, pipeline: 30, board: 101, byokPipeline: 10, byokBoard: 20 },
});
