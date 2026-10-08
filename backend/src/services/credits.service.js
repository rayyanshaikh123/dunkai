import mongoose from 'mongoose';
import { env } from '../config/env.js';
import { CREDIT_TARIFF_VERSION, FREE_CHATS_PER_MONTH, TRIAL_CREDITS, creditQuote } from '../config/credits.js';
import { AiCharge } from '../models/AiCharge.js';
import { CreditEntry } from '../models/CreditEntry.js';
import { Usage } from '../models/Usage.js';
import { Wallet } from '../models/Wallet.js';
import { User } from '../models/User.js';
import { Chat } from '../models/Chat.js';
import { ApiError } from '../utils/ApiError.js';

export const currentCreditPeriod = (date = new Date()) => date.toISOString().slice(0, 7);

const DESIGN_ACTIONS = new Set([
  'chat', 'run_workflow', 'generate_requirements', 'generate_architecture', 'generate_components',
  'generate_eda', 'generate_pcb', 'generate_validation', 'generate_documentation',
  'generate_code', 'generate_board', 'revise_interfaces',
]);
const activeFreeDesign = (chat, period) => {
  const design = chat.freeDesign;
  if (!design?.period) return null;
  const completed = design.completedActions || [];
  // An unfinished included design can be finished after the month changes.
  if (design.period !== period && completed.includes('run_workflow') && completed.includes('generate_board')) return null;
  return design;
};
const includesAction = (design, action) => {
  if (!DESIGN_ACTIONS.has(action)) return false;
  if (!design) return true;
  const completed = design.completedActions || [];
  if (completed.includes(action)) return false;
  return action === 'generate_board' || !completed.includes('run_workflow');
};
const ownedDesignChat = async (user, chatId, projectId, session = null) => {
  const chat = await Chat.findOne({ _id: chatId, user: user._id }).session(session);
  if (!chat) throw ApiError.notFound('Chat not found');
  if (projectId && String(chat.project) !== String(projectId)) throw ApiError.forbidden('Chat does not belong to this project');
  return chat;
};

/** Read-only quote using the same eligibility rule as transactional admission. */
export const quoteCharge = async (user, { action, byok = false, chatId, projectId }) => {
  const quote = creditQuote({ action, byok });
  if (env.localRuntimeEnabled || !chatId) return quote;
  const period = currentCreditPeriod();
  const [chat, usage] = await Promise.all([
    ownedDesignChat(user, chatId, projectId),
    Usage.findOne({ user: user._id, period }).lean(),
  ]);
  const design = activeFreeDesign(chat, period);
  const included = user.isVerified && includesAction(design, action)
    && (design || (usage?.freeDesignsUsed ?? 0) < FREE_CHATS_PER_MONTH);
  return { ...quote, credits: included ? 0 : quote.credits, included: Boolean(included),
    freeChatsRemaining: Math.max(0, FREE_CHATS_PER_MONTH - (usage?.freeDesignsUsed ?? 0)) };
};

const ensureWallet = async (userId) => {
  try {
    await Wallet.updateOne({ user: userId }, { $setOnInsert: { user: userId } }, { upsert: true });
  } catch (error) {
    if (error?.code !== 11000) throw error;
  }
};

const ensureUsage = async (userId, period) => {
  try {
    await Usage.updateOne({ user: userId, period }, { $setOnInsert: { user: userId, period } }, { upsert: true });
  } catch (error) {
    if (error?.code !== 11000) throw error;
  }
};

const entry = async (session, fields) => CreditEntry.create([fields], { session });

/** Trial credits are granted once, only after email/Google verification. */
export const getOrCreateWallet = async (user) => {
  await ensureWallet(user._id);
  if (env.creditMeteringEnabled && user.isVerified) {
    await mongoose.connection.transaction(async (session) => {
      const wallet = await Wallet.findOne({ user: user._id }).session(session);
      if (wallet.trialGranted) return;
      wallet.trialGranted = true;
      // Local CPU work is free; five hosted model calls are the free offer.
      const grant = env.localRuntimeEnabled ? 0 : TRIAL_CREDITS;
      wallet.trialAvailable += grant;
      await wallet.save({ session });
      if (grant) {
        await entry(session, {
          user: user._id, kind: 'trial_grant', availableTrialDelta: grant,
          idempotencyKey: `trial:${user._id}`,
        });
      }
    });
  }
  return Wallet.findOne({ user: user._id }).lean();
};

export const walletSummary = async (user) => {
  const [wallet, usage] = await Promise.all([
    getOrCreateWallet(user),
    Usage.findOne({ user: user._id, period: currentCreditPeriod() }).lean(),
  ]);
  return {
    currency: 'INR',
    trialAvailable: wallet.trialAvailable,
    paidAvailable: wallet.paidAvailable,
    reserved: wallet.trialReserved + wallet.paidReserved,
    available: wallet.trialAvailable + wallet.paidAvailable,
    freeChatsUsed: env.localRuntimeEnabled ? usage?.freeChatsUsed ?? 0 : usage?.freeDesignsUsed ?? 0,
    freeChatsLimit: FREE_CHATS_PER_MONTH,
    freeAllowanceUnit: env.localRuntimeEnabled ? 'model_call' : 'design_chat',
    period: currentCreditPeriod(),
  };
};

/** Reserve the published maximum before allowing any hosted or BYOK work. */
export const reserveCharge = async (user, jobId, { action, byok = false, chatId = null, projectId = null }) => {
  if (!env.creditMeteringEnabled) return null;
  if (env.localRuntimeEnabled && action !== 'local_inference') return null;
  const { credits, kind } = creditQuote({ action, byok });
  const period = currentCreditPeriod();
  await getOrCreateWallet(user);
  await ensureUsage(user._id, period);

  await mongoose.connection.transaction(async (session) => {
    const existing = await AiCharge.findOne({ jobId }).session(session);
    if (existing) {
      if (String(existing.user) !== String(user._id) || existing.action !== action || String(existing.chat || '') !== String(chatId || '')) {
        throw ApiError.conflict('Job ID is already in use');
      }
      return;
    }

    const wallet = await Wallet.findOne({ user: user._id }).session(session);
    const usage = await Usage.findOne({ user: user._id, period }).session(session);
    const chat = !env.localRuntimeEnabled && chatId ? await ownedDesignChat(user, chatId, projectId, session) : null;
    let design = chat ? activeFreeDesign(chat, period) : null;
    const freeDesign = Boolean(chat && user.isVerified && includesAction(design, action)
      && (design || usage.freeDesignsUsed < FREE_CHATS_PER_MONTH));
    if (freeDesign) {
      if (design?.pendingJobId) throw new ApiError(429, 'A run is already active in this free chat. Wait for it to finish.');
      if (!design) {
        design = { period, completedActions: [], successfulRequests: 0 };
        usage.freeDesignsUsed += 1;
        await usage.save({ session });
      }
      chat.freeDesign = { ...(design.toObject?.() || design), pendingJobId: jobId };
      await chat.save({ session });
    }
    // Preserve standalone/local model-call allowances; scoped hosted chats
    // use one monthly entitlement for their entire included design instead.
    const freeChat = !chat && kind === 'chat' && !byok && user.isVerified && usage.freeChatsUsed < FREE_CHATS_PER_MONTH;
    const reserve = freeChat || freeDesign ? 0 : credits;
    const reserveTrial = Math.min(wallet.trialAvailable, reserve);
    const reservePaid = reserve - reserveTrial;
    if (reserve > 0 && wallet.paidAvailable < reservePaid) {
      throw new ApiError(402, `This run needs ${reserve} credits. Add credits to continue.`, [
        { code: 'insufficient_credits', required: reserve, available: wallet.trialAvailable + wallet.paidAvailable },
      ]);
    }

    if (freeChat) {
      usage.freeChatsUsed += 1;
      await usage.save({ session });
    }
    if (reserve) {
      wallet.trialAvailable -= reserveTrial;
      wallet.paidAvailable -= reservePaid;
      wallet.trialReserved += reserveTrial;
      wallet.paidReserved += reservePaid;
      await wallet.save({ session });
      await entry(session, {
        user: user._id, jobId, kind: 'reserve',
        availableTrialDelta: -reserveTrial, availablePaidDelta: -reservePaid,
        reservedTrialDelta: reserveTrial, reservedPaidDelta: reservePaid,
        tariffVersion: CREDIT_TARIFF_VERSION, idempotencyKey: `reserve:${jobId}`,
      });
    }
    await AiCharge.create([{
      user: user._id, jobId, action, kind, period, byok, freeChat,
      chat: chat?._id, freeDesign, freeDesignPeriod: freeDesign ? design.period : undefined,
      freeDesignStep: freeDesign ? action : undefined,
      quoteCredits: credits, reserveTrial, reservePaid, tariffVersion: CREDIT_TARIFF_VERSION,
    }], { session });
  });
  return { jobId, credits, kind };
};

/** Idempotent completion/release. A failed run currently releases the full quote. */
export const settleCharge = async (jobId, result) => {
  if (!env.creditMeteringEnabled || !jobId) return;
  if (result?.data && typeof result.data === 'object') result = { ...result.data, providerUsage: result.providerUsage || result.data.providerUsage };
  await mongoose.connection.transaction(async (session) => {
    const charge = await AiCharge.findOne({ jobId }).session(session);
    if (!charge || charge.status !== 'reserved') return;

    const failed = !result || Boolean(result.error) || ['blocked', 'failed'].includes(result.workflow_status);
    const askedQuestion = result?.interview_status === 'question';
    if (!failed && askedQuestion && !charge.chat && charge.kind === 'pipeline' && !charge.byok && !charge.freeChat) {
      const owner = await User.findById(charge.user).select('isVerified').session(session);
      if (owner?.isVerified) {
        const free = await Usage.updateOne(
          { user: charge.user, period: charge.period, freeChatsUsed: { $lt: FREE_CHATS_PER_MONTH } },
          { $inc: { freeChatsUsed: 1 } }, { session }
        );
        charge.freeChat = free.modifiedCount > 0;
      }
    }
    if (charge.freeDesign) {
      const chat = await Chat.findOne({ _id: charge.chat, user: charge.user }).session(session);
      if (chat?.freeDesign?.period === charge.freeDesignPeriod && chat.freeDesign.pendingJobId === jobId) {
        if (failed && !chat.freeDesign.successfulRequests) {
          // A refused/failed first attempt does not consume a monthly slot.
          chat.freeDesign = undefined;
          await Usage.updateOne({ user: charge.user, period: charge.freeDesignPeriod, freeDesignsUsed: { $gt: 0 } },
            { $inc: { freeDesignsUsed: -1 } }, { session });
        } else {
          chat.freeDesign.pendingJobId = undefined;
          if (!failed) {
            chat.freeDesign.successfulRequests = (chat.freeDesign.successfulRequests || 0) + 1;
            if (!askedQuestion && charge.freeDesignStep !== 'chat') {
              // The original supervisor may route a workflow request to a
              // single stage. That must not spend the entire included run.
              const fullPipeline = charge.freeDesignStep !== 'run_workflow'
                || result.current_node === 'code_generation'
                || (!result.current_node && result.pcb_ir && result.bom);
              if (fullPipeline) chat.freeDesign.completedActions.addToSet(charge.freeDesignStep);
            }
          }
        }
        await chat.save({ session });
      }
    }
    const debit = failed || charge.freeChat || charge.freeDesign ? 0 : askedQuestion ? Math.min(charge.quoteCredits, charge.byok ? 0 : 2) : charge.quoteCredits;
    const debitTrial = Math.min(charge.reserveTrial, debit);
    const debitPaid = debit - debitTrial;
    const wallet = await Wallet.findOne({ user: charge.user }).session(session);
    wallet.trialReserved -= charge.reserveTrial;
    wallet.paidReserved -= charge.reservePaid;
    wallet.trialAvailable += charge.reserveTrial - debitTrial;
    wallet.paidAvailable += charge.reservePaid - debitPaid;
    await wallet.save({ session });
    if (failed && charge.freeChat) {
      await Usage.updateOne({ user: charge.user, period: charge.period, freeChatsUsed: { $gt: 0 } },
        { $inc: { freeChatsUsed: -1 } }, { session });
    }
    charge.status = failed ? 'released' : 'completed';
    charge.debitedCredits = debit;
    charge.providerUsage = Array.isArray(result?.providerUsage) ? result.providerUsage.slice(0, 100) : [];
    await charge.save({ session });
    if (charge.reserveTrial || charge.reservePaid) {
      await entry(session, {
        user: charge.user, jobId, kind: failed ? 'release' : 'settle',
        availableTrialDelta: charge.reserveTrial - debitTrial,
        availablePaidDelta: charge.reservePaid - debitPaid,
        reservedTrialDelta: -charge.reserveTrial, reservedPaidDelta: -charge.reservePaid,
        tariffVersion: charge.tariffVersion, idempotencyKey: `settle:${jobId}`,
      });
    }
  });
};
