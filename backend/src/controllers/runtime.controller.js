import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import mongoose from 'mongoose';
import { RuntimeDevice } from '../models/RuntimeDevice.js';
import { BoardArtifact } from '../models/BoardArtifact.js';
import { AiJob } from '../models/AiJob.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { ApiError } from '../utils/ApiError.js';
import { send } from '../utils/response.js';
import { env } from '../config/env.js';
import { getProject } from '../services/project.service.js';
import * as runtime from '../services/runtime.service.js';
import { runtimeCompletion } from '../services/runtimeInference.service.js';
import { reserveArtifactBytes, releaseArtifactBytes } from '../services/runtimeStorage.service.js';

export const pairing = asyncHandler(async (req, res) => send(res, { data: await runtime.beginPairing(req.body.name) }));
export const pairingPoll = asyncHandler(async (req, res) => send(res, { data: await runtime.pollPairing(req.body.deviceCode) }));
export const approve = asyncHandler(async (req, res) => send(res, { data: await runtime.approvePairing(req.body.code, req.user) }));
export const devices = asyncHandler(async (req, res) => send(res, { data: { localRuntimeEnabled: env.localRuntimeEnabled, devices: await runtime.listRuntimeDevices(req.user) } }));
export const prefer = asyncHandler(async (req, res) => {
  const device = await RuntimeDevice.findOne({ _id: req.params.id, user: req.user._id, revokedAt: null });
  if (!device) throw ApiError.notFound('Computer not found');
  await RuntimeDevice.updateMany({ user: req.user._id }, { $set: { preferred: false } });
  await RuntimeDevice.updateOne({ _id: device._id }, { $set: { preferred: true } });
  device.preferred = true;
  send(res, { data: runtime.deviceView(device) });
});
export const revoke = asyncHandler(async (req, res) => {
  const device = await RuntimeDevice.findOneAndUpdate({ _id: req.params.id, user: req.user._id }, { $set: { revokedAt: new Date(), ready: false } });
  if (!device) throw ApiError.notFound('Computer not found');
  for (const job of await AiJob.find({ device: device._id, status: { $in: ['queued', 'running'] } })) await runtime.cancelLocalJob(job, req.app.get('io'));
  send(res, { message: 'Computer disconnected' });
});
export const heartbeat = asyncHandler(async (req, res) => send(res, { data: await runtime.runtimeHeartbeat(req.runtimeDevice, req.body) }));
export const claim = asyncHandler(async (req, res) => send(res, { data: await runtime.claimLocalJob(req.runtimeDevice, req.body.leaseToken) }));
export const events = asyncHandler(async (req, res) => {
  await runtime.localJobEvent(req.runtimeDevice, req.params.jobId, req.headers['x-runtime-lease'], req.body, req.app.get('io'));
  send(res, { message: 'Event saved' });
});

export const completion = asyncHandler(async (req, res) => {
  const job = await runtime.getLeasedJob(req.runtimeDevice, req.headers['x-runtime-job'], req.headers['x-runtime-lease']);
  const answer = await runtimeCompletion(req.user, req.runtimeDevice, job, req.headers['x-inference-id'], req.body);
  if (answer.retryAfter) res.set('Retry-After', String(answer.retryAfter));
  if (req.body.stream === true && answer.status === 200) {
    const body = answer.body;
    const chunk = { id: body.id, object: 'chat.completion.chunk', created: body.created, model: body.model };
    res.set('Content-Type', 'text/event-stream'); res.set('Cache-Control', 'no-store');
    res.write('data: ' + JSON.stringify({ ...chunk, choices: body.choices.map((choice) => ({
      index: choice.index, delta: { ...choice.message, ...(choice.message.tool_calls ? { tool_calls: choice.message.tool_calls.map((call, index) => ({ index, ...call })) } : {}) }, finish_reason: null,
    })) }) + '\n\n');
    res.write('data: ' + JSON.stringify({ ...chunk, choices: body.choices.map((choice) => ({ index: choice.index, delta: {}, finish_reason: choice.finish_reason })), usage: body.usage }) + '\n\n');
    return res.end('data: [DONE]\n\n');
  }
  res.status(answer.status).json(answer.body);
});

const DATASETS = new Set(['components_ml.parquet', 'component_embeddings.npy', 'component_faiss.index']);
export const dataset = asyncHandler(async (req, res) => {
  if (!req.user.isVerified) throw ApiError.forbidden('Verify your account before downloading component data');
  if (!DATASETS.has(req.params.name)) throw ApiError.notFound('Dataset file not found');
  const response = await fetch('https://huggingface.co/datasets/rayyanshk/dunkai/resolve/main/' + req.params.name, {
    headers: env.hfTokenRead ? { authorization: 'Bearer ' + env.hfTokenRead } : {},
    signal: AbortSignal.timeout(300_000),
  });
  if (!response.ok) throw new ApiError(503, 'The component dataset is unavailable. Configure HF_TOKEN_READ on the backend.');
  res.set('Content-Type', 'application/octet-stream'); res.set('Cache-Control', 'private, no-store');
  if (response.headers.get('content-length')) res.set('Content-Length', response.headers.get('content-length'));
  await pipeline(Readable.fromWeb(response.body), res);
});

export const artifact = asyncHandler(async (req, res) => {
  const job = await runtime.getLeasedJob(req.runtimeDevice, req.params.jobId, req.headers['x-runtime-lease']);
  const kind = req.params.kind, filename = runtime.ARTIFACT_FILES[kind];
  if (!filename || !Buffer.isBuffer(req.body) || !req.body.length) throw ApiError.badRequest('Invalid artifact');
  await getProject(job.project, req.user, true);
  const hash = runtime.hashRuntimeSecret(req.body);
  const directory = 'local-' + job.jobId;
  await BoardArtifact.updateOne({ jobId: job.jobId }, { $setOnInsert: { jobId: job.jobId, user: job.user, project: job.project, chat: job.chat, directory, urls: {}, files: {} } }, { upsert: true });
  const record = await BoardArtifact.findOne({ jobId: job.jobId, user: job.user });
  if (record.files?.[kind]) {
    if (record.files[kind].sha256 !== hash) throw ApiError.conflict('A different artifact already exists for this job');
    return send(res, { data: { url: record.urls[kind] } });
  }
  const bucket = new mongoose.mongo.GridFSBucket(mongoose.connection.db, { bucketName: 'runtimeArtifacts' });
  await reserveArtifactBytes(job.user, req.body.length);
  const upload = bucket.openUploadStream(filename, { metadata: { user: String(job.user), project: String(job.project), chat: String(job.chat || ''), jobId: job.jobId, kind, sha256: hash } });
  try {
    await new Promise((resolve, reject) => { upload.once('finish', resolve); upload.once('error', reject); upload.end(req.body); });
    await runtime.getLeasedJob(req.runtimeDevice, req.params.jobId, req.headers['x-runtime-lease']);
    await getProject(job.project, req.user, true);
  } catch (error) {
    await bucket.delete(upload.id).catch(() => {});
    await releaseArtifactBytes(job.user, req.body.length);
    throw error;
  }
  const url = '/uploads/boards/' + directory + '/' + filename;
  const saved = await BoardArtifact.updateOne({ _id: record._id, ['files.' + kind]: { $exists: false } }, { $set: { ['files.' + kind]: { id: upload.id, sha256: hash, size: req.body.length }, ['urls.' + kind]: url } });
  if (!saved.modifiedCount) {
    await bucket.delete(upload.id);
    await releaseArtifactBytes(job.user, req.body.length);
    const prior = await BoardArtifact.findById(record._id);
    if (prior.files?.[kind]?.sha256 !== hash) throw ApiError.conflict('A different artifact already exists for this job');
  }
  send(res, { data: { url } });
});

export const download = asyncHandler(async (_req, res) => {
  const source = path.resolve('public', 'dunkai-runtime.zip');
  if (!fs.existsSync(source)) throw new ApiError(503, 'Build the runtime download with npm run package:runtime on the backend.');
  res.set('Cache-Control', 'private, no-store');
  res.download(source, 'dunkai-runtime.zip');
});
