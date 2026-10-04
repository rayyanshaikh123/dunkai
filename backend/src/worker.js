import { Worker } from 'bullmq';
import { Emitter } from '@socket.io/redis-emitter';
import { connectDatabase } from './config/database.js';
import { AiJob } from './models/AiJob.js';
import { AiCharge } from './models/AiCharge.js';
import { User } from './models/User.js';
import { resolveCredentials } from './services/apiKey.service.js';
import { settleCharge } from './services/credits.service.js';
import { callSupervisorStream } from './services/supervisor.service.js';
import { AI_QUEUE_NAME, redisConnection } from './services/queue.service.js';
import { emitAIError } from './sockets/index.js';

await connectDatabase();
const connection = redisConnection();
await connection.ping();
const emitter = new Emitter(connection);
const cancels = connection.duplicate();
const running = new Map();
await cancels.subscribe('dunkai-ai-cancel');
cancels.on('message', (_channel, jobId) => running.get(jobId)?.abort());

const worker = new Worker(AI_QUEUE_NAME, async ({ data }) => {
  const record = await AiJob.findOneAndUpdate(
    { jobId: data.jobId, status: 'queued' }, { $set: { status: 'running' } }, { new: true }
  ).select('+payload');
  if (!record) return;
  const controller = new AbortController();
  running.set(record.jobId, controller);
  try {
  const user = await User.findById(record.user);
  if (!user || !user.isActive) throw new Error('Job owner unavailable');
  const payload = record.payload;
  if (!payload) throw new Error('Job payload missing');
  const credentials = await resolveCredentials(user._id);
  const charge = await AiCharge.findOne({ jobId: record.jobId });
  if (charge?.byok) {
    const credential = record.action === 'generate_board' ? payload.provider || 'groq' : 'groq';
    if (!credentials[credential]) throw new Error('The saved provider key was removed before this job started');
  } else if (charge && record.action !== 'generate_board') {
    delete credentials.groq;
  } else if (charge?.kind === 'board') {
    delete credentials[payload.provider || 'groq'];
  }
    if (controller.signal.aborted || (await AiJob.findOne({ jobId: record.jobId }))?.status === 'cancelled') return;
    const result = await callSupervisorStream(emitter, {
      action: record.action, project: payload.project, messages: payload.messages,
      files: payload.files, agentType: payload.agentType, provider: payload.provider,
      model: payload.model, credentials, jobId: record.jobId, chatId: record.chat,
      audit: { userId: record.user, projectId: record.project },
      signal: controller.signal,
      onComplete: async (completed) => {
        const claimed = await AiJob.updateOne(
          { jobId: record.jobId, status: 'running' }, { $set: { status: 'completing' } }
        );
        if (!claimed.modifiedCount) throw new Error('Job cancelled or already settled');
        await settleCharge(record.jobId, completed);
        await AiJob.updateOne({ jobId: record.jobId, status: 'completing' },
          { $set: { status: 'completed', result: completed }, $unset: { payload: 1 } });
      },
    });
    if (result?.error) {
      await settleCharge(record.jobId, result);
      throw new Error(result.error);
    }
  } catch (error) {
    await settleCharge(record.jobId, null);
    const status = (await AiJob.findOne({ jobId: record.jobId }))?.status;
    if (status !== 'cancelled' && status !== 'completed') {
      await AiJob.updateOne({ jobId: record.jobId, status: { $in: ['queued', 'running', 'completing'] } },
        { $set: { status: 'failed', error: error.message }, $unset: { payload: 1 } });
      emitAIError(emitter, record.jobId, { jobId: record.jobId, error: error.message });
      throw error;
    }
  } finally {
    running.delete(record.jobId);
  }
}, { connection, concurrency: 2, lockDuration: 20 * 60 * 1000 });

worker.on('failed', (job, error) => console.error(`[AI Worker] ${job?.id} failed:`, error));
console.info('[AI Worker] ready');
