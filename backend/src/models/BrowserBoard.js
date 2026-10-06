import mongoose from 'mongoose';

// Browser results are untrusted previews. Never use this document as a
// manufacturing approval or as proof that the supplied circuit passed DRC.
const browserBoardSchema = new mongoose.Schema({
  chat: { type: mongoose.Schema.Types.ObjectId, ref: 'Chat', required: true, unique: true },
  project: { type: mongoose.Schema.Types.ObjectId, ref: 'Project', required: true, index: true },
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  sourceHash: { type: String, required: true },
  pcbSvg: { type: String, required: true },
  schematicSvg: { type: String, required: true },
  circuitJson: { type: String, required: true },
}, { timestamps: true });

export const BrowserBoard = mongoose.model('BrowserBoard', browserBoardSchema);
