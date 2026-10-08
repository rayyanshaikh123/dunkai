import { createHash, randomBytes, randomUUID } from 'node:crypto';
import mongoose from 'mongoose';
import { isDeepStrictEqual } from 'node:util';
import { RuntimeDevice } from '../models/RuntimeDevice.js';
import { RuntimePairing } from '../models/RuntimePairing.js';
import { AiJob } from '../models/AiJob.js';
import { BoardArtifact } from '../models/BoardArtifact.js';
import { getProject } from './project.service.js';
import { Chat } from '../models/Chat.js';
import { Project } from '../models/Project.js';
import { env } from '../config/env.js';
import { ApiError } from '../utils/ApiError.js';
import { encryptSecret, decryptSecret } from '../utils/secrets.js';
import { emitAIProgress, emitAIComplete, emitAIError } from '../sockets/index.js';

export const hashRuntimeSecret = (value) => createHash('sha256').update(value).digest('hex');
export const ARTIFACT_FILES = Object.freeze({
  circuitJson: 'circuit.json', schematicSvg: 'schematic.svg', pcbSvg: 'pcb.svg',
  boardGlb: 'board.glb', boardGltfJson: 'board.gltf.json', bomCsv: 'bom.csv', pickAndPlaceCsv: 'pick-and-place.csv',
  designBrief: 'design-brief.md', resolution: 'resolution.json',
});
const onlineFilter = () => ({ revokedAt: null, expiresAt: { $gt: new Date() }, ready: true, lastSeenAt: { $gt: new Date(Date.now() - 45_000) } });
export const deviceView = (device) => ({
  id: String(device._id), name: device.name, mode: device.mode, preferred: device.preferred,
  ready: device.ready, connected: !device.revokedAt && device.expiresAt > new Date() && device.lastSeenAt > new Date(Date.now() - 45_000),
  lastSeenAt: device.lastSeenAt, expiresAt: device.expiresAt, capabilities: device.capabilities,
});
export const listRuntimeDevices = async (user) => (await RuntimeDevice.find({ user: user._id, revokedAt: null }).sort({ preferred: -1, createdAt: -1 })).map(deviceView);

export const beginPairing = async (name) => {
  if (typeof name !== 'string' || !name.trim() || name.length > 100) throw ApiError.badRequest('Provide a computer name');
  const deviceCode = randomBytes(32).toString('hex');
  const userCode = randomBytes(5).toString('hex').toUpperCase();
  await RuntimePairing.create({ name: name.trim(), deviceCodeHash: hashRuntimeSecret(deviceCode), userCodeHash: hashRuntimeSecret(userCode), expiresAt: new Date(Date.now() + 10 * 60_000) });
  return { deviceCode, userCode: userCode.slice(0, 5) + '-' + userCode.slice(5), expiresIn: 600, interval: 3 };
};

export const approvePairing = async (code, user) => {
  if (!user.isVerified) throw ApiError.forbidden('Verify your account before connecting a computer');
  const normalized = String(code || '').replace(/-/g, '').toUpperCase();
  if (!/^[A-F0-9]{10}$/.test(normalized)) throw ApiError.badRequest('Invalid pairing code');
  let device;
  await mongoose.connection.transaction(async (session) => {
    const pairing = await RuntimePairing.findOne({ userCodeHash: hashRuntimeSecret(normalized), expiresAt: { $gt: new Date() } }).session(session);
    if (!pairing) throw ApiError.notFound('Pairing code expired or not found');
    if (pairing.user) {
      if (String(pairing.user) !== String(user._id)) throw ApiError.conflict('This computer has already been paired');
      device = await RuntimeDevice.findById(pairing.device).session(session);
      return;
    }
    const token = randomBytes(32).toString('hex');
    await RuntimeDevice.updateMany({ user: user._id, preferred: true }, { $set: { preferred: false } }, { session });
    [device] = await RuntimeDevice.create([{ user: user._id, name: pairing.name, tokenHash: hashRuntimeSecret(token), expiresAt: new Date(Date.now() + 30 * 86400_000) }], { session });
    pairing.user = user._id; pairing.device = device._id; pairing.encryptedToken = encryptSecret(token);
    await pairing.save({ session });
  });
  return deviceView(device);
};

export const pollPairing = async (code) => {
  if (!/^[a-f0-9]{64}$/.test(String(code))) throw ApiError.badRequest('Invalid device code');
  const pairing = await RuntimePairing.findOne({ deviceCodeHash: hashRuntimeSecret(code), expiresAt: { $gt: new Date() } }).select('+encryptedToken');
  if (!pairing) throw ApiError.notFound('Pairing request expired');
  if (!pairing.user) return { status: 'pending' };
  const device = await RuntimeDevice.findOne({ _id: pairing.device, revokedAt: null });
  if (!device) throw ApiError.forbidden('Device has been revoked');
  return { status: 'approved', token: decryptSecret(pairing.encryptedToken), device: deviceView(device) };
};

export const selectRuntimeDevice = async (userId) => {
  const device = await RuntimeDevice.findOne({ user: userId, ...onlineFilter() }).sort({ preferred: -1, lastSeenAt: -1 });
  if (!device) throw new ApiError(503, 'Connect DunkAI Runtime in Settings on your computer before starting this design.');
  return device;
};

export const queueLocalJob = async ({ userId, project, chatId = null, action, messages = [], files = [], agentType = null, provider = null, model = null, jobId = randomUUID() }) => {
  if (typeof project === 'string' || project instanceof mongoose.Types.ObjectId) project = (await getProject(project, { _id: userId }, true)).toObject();
  if (!project?._id) throw ApiError.badRequest('A project is required for local execution');
  if (chatId) {
    const chat = await Chat.findOne({ _id: chatId, user: userId, project: project._id });
    if (!chat) throw ApiError.notFound('Chat not found');
  }
  await getProject(project._id, { _id: userId }, true);
  if (provider && provider !== 'groq') throw ApiError.badRequest('The local runtime currently supports Groq. Select Groq in Settings.');
  const device = await selectRuntimeDevice(userId);
  if (action === 'generate_board' && device.capabilities?.boardSandbox !== true) throw new ApiError(503, 'The local board sandbox is unavailable. Restart the Docker runtime before generating a PCB.');
  if (await AiJob.countDocuments({ device: device._id, status: { $in: ['queued', 'running', 'completing'] }, jobId: { $ne: jobId } }) >= 2) throw new ApiError(429, 'This computer already has two jobs. Wait for one to finish.');
  const fields = { user: userId, project: project?._id || null, chat: chatId, action, execution: 'local', device: device._id, mode: device.mode, status: 'queued',
    payload: { action, project, messages, files, agentType, provider: 'groq', model, jobId } };
  const prior = await AiJob.findOne({ jobId });
  if (prior && String(prior.user) !== String(userId)) throw ApiError.conflict('Job ID already in use');
  if (prior) {
    const changed = await AiJob.updateOne({ jobId, user: userId, status: 'running', execution: 'cloud' }, { $set: fields });
    if (!changed.modifiedCount) throw ApiError.conflict('This job has already been queued');
  }
  else await AiJob.create({ jobId, ...fields });
  return { jobId };
};

export const executeLocalRequest = async (options) => {
  const { jobId } = await queueLocalJob(options);
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const job = await AiJob.findOne({ jobId, user: options.userId });
    if (job?.status === 'completed') return { jobId, status: 'completed', data: job.result };
    if (['failed', 'cancelled'].includes(job?.status)) throw new ApiError(502, job.error || 'Local job failed');
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new ApiError(504, 'The local job is still running. Check its status in the workspace.');
};

export const claimLocalJob = async (device, leaseToken) => {
  if (!/^[a-f0-9]{64}$/.test(String(leaseToken))) throw ApiError.badRequest('Invalid job lease');
  const leaseHash = hashRuntimeSecret(leaseToken);
  const prior = await AiJob.findOne({ device: device._id, status: { $in: ['running', 'completing'] } }).select('+payload +leaseHash');
  if (prior) {
    if (prior.leaseHash !== leaseHash) throw ApiError.conflict('Another runner is executing this computer’s job');
    if (prior.leaseUntil < new Date()) throw ApiError.conflict('The job lease expired; retry from the website');
    return { jobId: prior.jobId, mode: prior.mode, eventSequence: prior.eventSequence, payload: prior.payload };
  }
  if (device.activeJob) await RuntimeDevice.updateOne({ _id: device._id, activeJob: device.activeJob }, { $set: { activeJob: null } });
  const next = await AiJob.findOne({ device: device._id, execution: 'local', status: 'queued' }).sort({ createdAt: 1 });
  if (!next) return null;
  const lock = await RuntimeDevice.findOneAndUpdate({ _id: device._id, activeJob: null, revokedAt: null }, { $set: { activeJob: next.jobId } });
  if (!lock) return null;
  const claimed = await AiJob.findOneAndUpdate({ _id: next._id, status: 'queued' }, { $set: { status: 'running', leaseHash, leaseUntil: new Date(Date.now() + 45_000) } }, { new: true }).select('+payload');
  if (!claimed) await RuntimeDevice.updateOne({ _id: device._id, activeJob: next.jobId }, { $set: { activeJob: null } });
  return claimed ? { jobId: claimed.jobId, mode: claimed.mode, eventSequence: claimed.eventSequence, payload: claimed.payload } : null;
};

export const getLeasedJob = async (device, jobId, leaseToken, { completed = false } = {}) => {
  if (typeof jobId !== 'string' || !/^[a-f0-9-]{36}$/i.test(jobId) || !/^[a-f0-9]{64}$/.test(String(leaseToken))) throw ApiError.badRequest('Invalid job lease');
  const job = await AiJob.findOne({ jobId, device: device._id, user: device.user, execution: 'local', leaseHash: hashRuntimeSecret(leaseToken) }).select('+payload');
  if (!job) throw ApiError.notFound('Local job not found');
  if (completed && job.status === 'completed') return job;
  if (!['running', 'completing'].includes(job.status) || job.leaseUntil < new Date()) throw ApiError.conflict('The local job is no longer active');
  return job;
};

export const runtimeHeartbeat = async (device, { ready = false, mode = 'hosted', capabilities = {}, jobId, leaseToken }) => {
  if (!['hosted', 'byok'].includes(mode)) throw ApiError.badRequest('Invalid inference mode');
  await RuntimeDevice.updateOne({ _id: device._id, revokedAt: null }, { $set: { ready: ready === true, mode, lastSeenAt: new Date(), capabilities: { boardSandbox: capabilities.boardSandbox === true, version: String(capabilities.version || '').slice(0, 40) } } });
  if (!jobId) return { status: 'idle' };
  const job = await AiJob.findOne({ jobId, device: device._id, user: device.user, leaseHash: hashRuntimeSecret(String(leaseToken || '')) });
  if (!job) throw ApiError.notFound('Local job not found');
  if (['running', 'completing'].includes(job.status)) {
    const extended = await AiJob.updateOne({ _id: job._id, status: { $in: ['running', 'completing'] }, leaseUntil: { $gt: new Date() } }, { $set: { leaseUntil: new Date(Date.now() + 45_000) } });
    if (!extended.matchedCount) throw ApiError.conflict('The job lease expired');
  }
  return { status: job.status };
};

export const finishLocalJob = async (job, data, io) => {
  if (job.status === 'completed') return;
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw ApiError.badRequest('Invalid engine result');
  const { takeSafetyAudit } = await import('./supervisor.service.js');
  // Local clients cannot certify hardware or supply authoritative billing usage.
  takeSafetyAudit(data); delete data.providerUsage;
  const prior = job.payload?.project || {};
  const changedComponents = Boolean((data.bom && !isDeepStrictEqual(data.bom, prior.bom)) || (data.pcb_ir && !isDeepStrictEqual(data.pcb_ir, prior.pcb_ir)));
  const newBoard = Boolean(data.board && !isDeepStrictEqual(data.board, prior.board));
  if (job.action === 'generate_board' && !newBoard) throw ApiError.badRequest('The board job returned no new board');
  if (newBoard) {
    const record = await BoardArtifact.findOne({ jobId: job.jobId, user: job.user, project: job.project });
    if (!record || !record.files?.circuitJson || !record.files?.pcbSvg || !record.files?.schematicSvg) throw ApiError.badRequest('The board files have not finished uploading');
    data.board = { ...data.board, out_dir: '', urls: record.urls, execution: 'local', verified: false };
  } else if (changedComponents) {
    // Original supervisor responses include their input state as well as new
    // output. A copied old board must not accompany changed components.
    data.board = null;
  }
  // Completion and persisted design are committed together. A cancellation,
  // removed collaborator or deleted project cannot publish a stale result.
  await getProject(job.project, { _id: job.user }, true);
  let changed = false;
  await mongoose.connection.transaction(async (session) => {
    const current = await AiJob.findOne({ _id: job._id, status: { $in: ['running', 'completing'] }, leaseUntil: { $gt: new Date() } }).session(session);
    if (!current) throw ApiError.conflict('The local job is no longer active');
    const keys = ['requirements', 'architecture', 'bom', 'eda_data', 'pcb_ir', 'validation', 'handoff_validation', 'documentation', 'code_generation'];
    const fields = Object.fromEntries(keys.filter((key) => data[key] && typeof data[key] === 'object').map((key) => [key, data[key]]));
    if (data.board || changedComponents) fields.board = data.board || {};
    const target = job.chat
      ? await Chat.findOne({ _id: job.chat, user: job.user, project: job.project }).session(session)
      : await Project.findById(job.project).session(session);
    if (!target) throw ApiError.notFound('The design was deleted');
    for (const [key, value] of Object.entries(fields)) { target[key] = value; target.markModified(key); }
    await target.save({ session });
    current.status = 'completed'; current.result = data; current.payload = null;
    await current.save({ session }); changed = true;
  });
  if (changed && io) emitAIComplete(io, job.jobId, { jobId: job.jobId, data, status: 'completed' });
};

export const localJobEvent = async (device, jobId, leaseToken, { event, data, sequence }, io) => {
  const job = await getLeasedJob(device, jobId, leaseToken, { completed: event === 'complete' });
  if (event === 'complete') return finishLocalJob(job, data?.data || data, io);
  if (event === 'error') {
    const error = String(data?.error || 'Local engine failed').slice(0, 2000);
    await AiJob.updateOne({ _id: job._id, status: 'running' }, { $set: { status: 'failed', error }, $unset: { payload: 1 } });
    if (io) emitAIError(io, jobId, { error });
  } else if (event === 'progress') {
    if (!Number.isSafeInteger(sequence) || sequence < 1) throw ApiError.badRequest('Invalid event sequence');
    const changed = await AiJob.updateOne({ _id: job._id, status: 'running', eventSequence: { $lt: sequence } }, { $set: { eventSequence: sequence, progress: data } });
    if (changed.modifiedCount && io) emitAIProgress(io, jobId, data);
  } else throw ApiError.badRequest('Unsupported runtime event');
};

export const cancelLocalJob = async (job, io) => {
  const changed = await AiJob.updateOne({ _id: job._id, status: { $in: ['queued', 'running'] } }, { $set: { status: 'cancelled', error: 'Job cancelled' }, $unset: { payload: 1 } });
  if (changed.modifiedCount && io) emitAIError(io, job.jobId, { error: 'Job cancelled' });
  return { jobId: job.jobId, status: changed.modifiedCount ? 'cancelled' : job.status };
};

export const reconcileRuntimeJobs = async (io) => {
  const jobs = await AiJob.find({ execution: 'local', $or: [
    { status: { $in: ['running', 'completing'] }, leaseUntil: { $lt: new Date() } },
    { status: 'queued', createdAt: { $lt: new Date(Date.now() - 120_000) } },
  ] });
  for (const job of jobs) {
    const changed = await AiJob.updateOne({ _id: job._id, status: job.status, updatedAt: job.updatedAt }, { $set: { status: 'failed', error: 'The local computer disconnected. Reconnect the runtime and retry.' }, $unset: { payload: 1 } });
    if (changed.modifiedCount && io) emitAIError(io, job.jobId, { error: 'The local computer disconnected. Reconnect the runtime and retry.' });
  }
};
