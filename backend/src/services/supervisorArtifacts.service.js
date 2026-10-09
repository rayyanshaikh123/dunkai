import mongoose from 'mongoose';
import { createHash } from 'node:crypto';
import { finished } from 'node:stream/promises';
import { BoardArtifact } from '../models/BoardArtifact.js';
import { ApiError } from '../utils/ApiError.js';
import { reserveArtifactBytes, releaseArtifactBytes } from './runtimeStorage.service.js';

const FILES = {
  circuitJson: 'circuit.json', schematicSvg: 'schematic.svg', pcbSvg: 'pcb.svg',
  boardGlb: 'board.glb', boardGltfJson: 'board.gltf.json', bomCsv: 'bom.csv',
  pickAndPlaceCsv: 'pick-and-place.csv', designBrief: 'design-brief.md', resolution: 'resolution.json',
  systemAssembly: 'system-assembly.json',
};
const REQUIRED = ['circuitJson', 'schematicSvg', 'pcbSvg'];
const LIMIT = 32 * 1024 * 1024;

async function limitedBody(response) {
  const advertised = Number(response.headers.get('content-length'));
  if (advertised > LIMIT) throw new ApiError(413, 'Generated board file exceeds the storage limit');
  const reader = response.body.getReader();
  const chunks = []; let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      size += value.length;
      if (size > LIMIT) throw new ApiError(413, 'Generated board file exceeds the storage limit');
      chunks.push(Buffer.from(value));
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  if (!size) throw ApiError.badGateway('The generated board file is empty');
  return Buffer.concat(chunks, size);
}

/** Copy authorized results off ephemeral Space storage before completion. */
export async function archiveSupervisorBoard(board, { jobId, userId, projectId, chatId }, fetchArtifact) {
  if (!/^[a-zA-Z0-9-]{1,100}$/.test(jobId || '') || !userId || !projectId) throw ApiError.badGateway('Board storage context is missing');
  const previous = await BoardArtifact.findOne({ jobId });
  if (previous && (String(previous.user) !== String(userId) || String(previous.project) !== String(projectId) || String(previous.chat || '') !== String(chatId || ''))) {
    throw ApiError.forbidden('Board storage belongs to another design');
  }
  if (previous && REQUIRED.every((kind) => previous.files?.[kind]?.id)) return { ...board, urls: previous.urls, verified: false };
  if (!REQUIRED.every((kind) => typeof board.urls?.[kind] === 'string')) throw ApiError.badGateway('The engine returned incomplete board files');
  const directory = 'space-' + jobId;
  const bucket = new mongoose.mongo.GridFSBucket(mongoose.connection.db, { bucketName: 'runtimeArtifacts' });
  const uploaded = [], urls = {}, files = {};
  try {
    for (const [kind, filename] of Object.entries(FILES)) {
      const source = board.urls?.[kind]; if (!source) continue;
      if (typeof source !== 'string' || !source.startsWith('/uploads/boards/')) throw ApiError.badGateway('The engine returned an invalid board path');
      const relative = source.slice('/uploads/boards/'.length);
      if (!/^[a-zA-Z0-9._/-]+$/.test(relative) || relative.split('/').some((part) => !part || part === '..' || part === '.')) throw ApiError.badGateway('The engine returned an unsafe board path');
      const response = await fetchArtifact(relative);
      if (!response.ok || !response.body) throw ApiError.badGateway('Could not archive the generated ' + filename);
      const bytes = await limitedBody(response);
      await reserveArtifactBytes(userId, bytes.length);
      const stream = bucket.openUploadStream(directory + '/' + filename, { metadata: { user: String(userId), project: String(projectId), chat: String(chatId || ''), jobId, kind } });
      try {
        const completion = finished(stream); stream.end(bytes); await completion;
      } catch (error) {
        await bucket.delete(stream.id).catch(() => {});
        await releaseArtifactBytes(userId, bytes.length); throw error;
      }
      uploaded.push({ id: stream.id, size: bytes.length });
      urls[kind] = '/uploads/boards/' + directory + '/' + filename;
      files[kind] = { id: stream.id, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
    }
    await BoardArtifact.updateOne({ jobId }, { $set: {
      jobId, directory, user: userId, project: projectId, chat: chatId || null, urls, files, stats: board.stats || {},
    } }, { upsert: true });
    return { ...board, urls, verified: false };
  } catch (error) {
    for (const file of uploaded) { await bucket.delete(file.id).catch(() => {}); await releaseArtifactBytes(userId, file.size); }
    throw error;
  }
}
