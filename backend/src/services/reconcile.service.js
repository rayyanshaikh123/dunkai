import { AiJob } from '../models/AiJob.js';
import { AiCharge } from '../models/AiCharge.js';
import { settleCharge } from './credits.service.js';

/** Release reservations left by a process crash. Runs only after a long grace period. */
export const reconcileStaleJobs = async () => {
  const cutoff = new Date(Date.now() - 60 * 60 * 1000);
  const stale = await AiJob.find({ status: { $in: ['queued', 'running', 'completing'] }, updatedAt: { $lt: cutoff } }).select('jobId');
  for (const job of stale) {
    const claimed = await AiJob.updateOne(
      { _id: job._id, status: { $in: ['queued', 'running', 'completing'] } },
      { $set: { status: 'failed', error: 'Job expired after service interruption' } }
    );
    if (claimed.modifiedCount) await settleCharge(job.jobId, null);
  }
  // Synchronous chat/code-chat reservations have no AiJob record. Release
  // those too if their web process died before settlement.
  const orphaned = await AiCharge.find({ status: 'reserved', updatedAt: { $lt: cutoff } }).select('jobId');
  for (const charge of orphaned) await settleCharge(charge.jobId, null);
};
