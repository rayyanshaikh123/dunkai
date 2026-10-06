import mongoose from 'mongoose';
import { env } from '../config/env.js';
import { CREDIT_TARIFF_VERSION, FREE_CHATS_PER_MONTH, TRIAL_CREDITS, creditQuote } from '../config/credits.js';
import { AiCharge } from '../models/AiCharge.js';
import { CreditEntry } from '../models/CreditEntry.js';
import { Usage } from '../models/Usage.js';
import { Wallet } from '../models/Wallet.js';
import { User } from '../models/User.js';
import { ApiError } from '../utils/ApiError.js';

export const currentCreditPeriod = (date = new Date()) => date.toISOString().slice(0, 7);

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
      // Browser mode's free offer is five hosted model turns per month.
      // The legacy 150-credit project trial would silently add 75 more turns.
      const grant = env.browserComputeOnly ? 0 : TRIAL_CREDITS;
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
    freeChatsUsed: usage?.freeChatsUsed ?? 0,
    freeChatsLimit: FREE_CHATS_PER_MONTH,
    period: currentCreditPeriod(),
  };
};

/** Reserve the published maximum before allowing any hosted or BYOK work. */
export const reserveCharge = async (user, jobId, { action, byok = false }) => {
  if (!env.creditMeteringEnabled) return null;
  const { credits, kind } = creditQuote({ action, byok });
  const period = currentCreditPeriod();
  await getOrCreateWallet(user);
  await ensureUsage(user._id, period);

  await mongoose.connection.transaction(async (session) => {
    const existing = await AiCharge.findOne({ jobId }).session(session);
    if (existing) {
      if (String(existing.user) !== String(user._id) || existing.action !== action) {
        throw ApiError.conflict('Job ID is already in use');
      }
      return;
    }

    const wallet = await Wallet.findOne({ user: user._id }).session(session);
    const usage = await Usage.findOne({ user: user._id, period }).session(session);
    const freeChat = kind === 'chat' && !byok && user.isVerified && usage.freeChatsUsed < FREE_CHATS_PER_MONTH;
    const reserve = freeChat ? 0 : credits;
    const reserveTrial = Math.min(wallet.trialAvailable, reserve);
    const reservePaid = reserve - reserveTrial;
    if (wallet.paidAvailable < reservePaid) {
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
      quoteCredits: credits, reserveTrial, reservePaid, tariffVersion: CREDIT_TARIFF_VERSION,
    }], { session });
  });
  return { jobId, credits, kind };
};

/** Idempotent completion/release. A failed run currently releases the full quote. */
export const settleCharge = async (jobId, result) => {
  if (!env.creditMeteringEnabled || !jobId) return;
  await mongoose.connection.transaction(async (session) => {
    const charge = await AiCharge.findOne({ jobId }).session(session);
    if (!charge || charge.status !== 'reserved') return;

    const failed = !result || Boolean(result.error) || result.workflow_status === 'blocked';
    const askedQuestion = result?.interview_status === 'question';
    if (!failed && askedQuestion && charge.kind === 'pipeline' && !charge.byok && !charge.freeChat) {
      const owner = await User.findById(charge.user).select('isVerified').session(session);
      if (owner?.isVerified) {
        const free = await Usage.updateOne(
          { user: charge.user, period: charge.period, freeChatsUsed: { $lt: FREE_CHATS_PER_MONTH } },
          { $inc: { freeChatsUsed: 1 } }, { session }
        );
        charge.freeChat = free.modifiedCount > 0;
      }
    }
    const debit = failed || charge.freeChat ? 0 : askedQuestion ? Math.min(charge.quoteCredits, charge.byok ? 0 : 2) : charge.quoteCredits;
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
