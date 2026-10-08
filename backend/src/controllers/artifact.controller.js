import fs from 'node:fs';
import mongoose from 'mongoose';
import path from 'node:path';
import { asyncHandler } from '../utils/asyncHandler.js';
import { ApiError } from '../utils/ApiError.js';
import { env } from '../config/env.js';
import { File } from '../models/File.js';
import { BoardArtifact } from '../models/BoardArtifact.js';
import { getProject } from '../services/project.service.js';
import { proxyBoardArtifact } from '../services/supervisor.service.js';

const setPrivateHeaders = (res, name) => {
  res.set('Cache-Control', 'private, no-store');
  res.set('X-Content-Type-Options', 'nosniff');
  if (name.endsWith('.svg')) {
    res.set('Content-Disposition', 'attachment');
    res.set('Content-Security-Policy', 'sandbox');
  }
};

export const boardArtifact = asyncHandler(async (req, res, next) => {
  const relative = String(req.params[0] || '');
  const [directory] = relative.split('/');
  if (!directory || relative.includes('..') || !/^[a-zA-Z0-9._/-]+$/.test(relative)) {
    throw ApiError.notFound('Board artifact not found');
  }
  const record = await BoardArtifact.findOne({ directory });
  const url = `/uploads/boards/${relative}`;
  if (!record || !Object.values(record.urls || {}).includes(url)) throw ApiError.notFound('Board artifact not found');
  await getProject(record.project, req.user);
  if (record.chat && String(record.user) !== String(req.user._id)) {
    throw ApiError.forbidden('This chat artifact is private');
  }
  if (url === record.urls.gerbersZip || url.startsWith(`${record.urls.gerbersDir}/`)) {
    throw ApiError.forbidden('Fabrication export is blocked pending independent checks and approval');
  }
  setPrivateHeaders(res, relative);
  const kind = Object.keys(record.urls || {}).find((key) => record.urls[key] === url);
  if (kind && record.files?.[kind]?.id) {
    const bucket = new mongoose.mongo.GridFSBucket(mongoose.connection.db, { bucketName: 'runtimeArtifacts' });
    const filename = relative.split('/').at(-1);
    res.type(filename.endsWith('.svg') ? 'image/svg+xml' : filename.endsWith('.glb') ? 'model/gltf-binary' : filename.endsWith('.json') ? 'application/json' : filename.endsWith('.csv') ? 'text/csv' : 'text/plain');
    const stream = bucket.openDownloadStream(new mongoose.Types.ObjectId(String(record.files[kind].id)));
    stream.on('error', () => { if (!res.headersSent) res.status(404).end(); else res.destroy(); });
    return stream.pipe(res);
  }
  const root = path.resolve(env.uploadDir, 'boards');
  const local = path.resolve(root, relative);
  if (!local.startsWith(`${root}${path.sep}`)) throw ApiError.notFound('Board artifact not found');
  if (fs.existsSync(local) && fs.statSync(local).isFile()) return res.sendFile(local);
  return proxyBoardArtifact(req, res, next);
});

export const uploadArtifact = asyncHandler(async (req, res) => {
  const name = req.params.name;
  if (!/^[a-zA-Z0-9._-]+$/.test(name)) throw ApiError.notFound('File not found');
  const file = await File.findOne({ url: `/uploads/${name}`, isDeleted: false });
  if (!file) throw ApiError.notFound('File not found');
  if (String(file.uploadedBy) !== String(req.user._id)) {
    if (!file.project) throw ApiError.forbidden('File is private');
    await getProject(file.project, req.user);
  }
  const root = path.resolve(env.uploadDir);
  const local = path.resolve(file.path);
  if (!local.startsWith(`${root}${path.sep}`)) throw ApiError.notFound('File not found');
  setPrivateHeaders(res, name);
  return res.sendFile(local);
});
