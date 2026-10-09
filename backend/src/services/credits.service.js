import mongoose from 'mongoose';
import { env } from '../config/env.js';
import { CREDIT_TARIFF_VERSION, TRIAL_CREDITS, creditQuote } from '../config/credits.js';
import { AiCharge } from '../models/AiCharge.js';
import { CreditEntry } from '../models/CreditEntry.js';
import { Usage } from '../models/Usage.js';
import { Wallet } from '../models/Wallet.js';
import { Chat } from '../models/Chat.js';
import { ApiError } from '../utils/ApiError.js';

export const currentCreditPeriod = (date = new Date()) => date.toISOString().slice(0, 7);

const ownedDesignChat = async (user, chatId, projectId, session = null) => {
  const chat = await Chat.findOne({ _id: chatId, user: user._id }).session(session);
  if (!chat) throw ApiError.notFound('Chat not found');
  if (projectId && String(chat.project) !== String(projectId)) throw ApiError.forbidden('Chat does not belong to this project');
  return chat;
};

/** Chat creation is unlimited; AI actions use the same tariff for every chat. */
export const quoteCharge = async (user, { action, byok = false, chatId, projectId }) => {
  const quote = creditQuote({ action, byok });
  if (!env.localRuntimeEnabled && chatId) await ownedDesignChat(user, chatId, projectId);
  return { ...quote, included: false };
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
      const target = TRIAL_CREDITS;
      if (wallet.trialGranted && wallet.trialCreditsGranted >= target) return;
      let granted = wallet.trialCreditsGranted;
      if (granted == null) {
        const prior = await CreditEntry.find({ user: user._id, kind: { $in: ['trial_grant', 'trial_topup'] } })
          .select('availableTrialDelta').session(session).lean();
        granted = prior.reduce((total, item) => total + item.availableTrialDelta, 0);
      }
      const grant = Math.max(0, target - granted);
      wallet.trialGranted = true;
      wallet.trialCreditsGranted = granted + grant;
      wallet.trialAvailable += grant;
      await wallet.save({ session });
      if (grant) {
        await entry(session, {
          user: user._id, kind: granted ? 'trial_topup' : 'trial_grant', availableTrialDelta: grant,
          idempotencyKey: `trial:${user._id}:${target}`,
        });
      }
    });
  }
  return Wallet.findOne({ user: user._id }).lean();
};

export const walletSummary = async (user) => {
  const wallet = await getOrCreateWallet(user);
  return {
    currency: 'INR',
    trialAvailable: wallet.trialAvailable,
    paidAvailable: wallet.paidAvailable,
    reserved: wallet.trialReserved + wallet.paidReserved,
    available: wallet.trialAvailable + wallet.paidAvailable,
    unlimitedChats: true,
    freeChatsUsed: 0,
    freeChatsLimit: null,
    freeAllowanceUnit: 'credits',
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
    const chat = !env.localRuntimeEnabled && chatId ? await ownedDesignChat(user, chatId, projectId, session) : null;
    const reserve = credits;
    const reserveTrial = Math.min(wallet.trialAvailable, reserve);
    const reservePaid = reserve - reserveTrial;
    if (reserve > 0 && wallet.paidAvailable < reservePaid) {
      throw new ApiError(402, `This run needs ${reserve} credits. Add credits to continue.`, [
        { code: 'insufficient_credits', required: reserve, available: wallet.trialAvailable + wallet.paidAvailable },
      ]);
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
      user: user._id, jobId, action, kind, period, byok,
      chat: chat?._id, freeChat: false, freeDesign: false,
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

    const failed = !result || Boolean(result.error) || ['blocked', 'failed'].includes(result.workflow_status)
      || (charge.action === 'generate_board' && result.board?.stats?.traces === 0);
    const askedQuestion = result?.interview_status === 'question';
    // Honor zero-credit reservations admitted before monthly allowances ended.
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
