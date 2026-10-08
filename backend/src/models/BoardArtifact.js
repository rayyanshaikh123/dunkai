import mongoose from 'mongoose';

const boardArtifactSchema = new mongoose.Schema({
  jobId: { type: String, required: true, unique: true },
  directory: { type: String, required: true, index: true },
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  project: { type: mongoose.Schema.Types.ObjectId, ref: 'Project', required: true },
  chat: { type: mongoose.Schema.Types.ObjectId, ref: 'Chat', default: null },
  urls: { type: mongoose.Schema.Types.Mixed, required: true },
  stats: { type: mongoose.Schema.Types.Mixed, default: {} },
  files: { type: mongoose.Schema.Types.Mixed, default: {} },
}, { timestamps: true });

export const BoardArtifact = mongoose.model('BoardArtifact', boardArtifactSchema);
