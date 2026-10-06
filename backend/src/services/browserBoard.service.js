import { createHash } from 'node:crypto';
import mongoose from 'mongoose';
import { BrowserBoard } from '../models/BrowserBoard.js';
import { Chat } from '../models/Chat.js';
import { getChat } from './chat.service.js';
import { ApiError } from '../utils/ApiError.js';

const MAX_SVG = 500_000;
const MAX_JSON = 700_000;
const MAX_IR = 100_000;
const FILES = Object.freeze({ pcb: 'pcbSvg', schematic: 'schematicSvg', circuit: 'circuitJson' });

const canonical = (value, depth = 0) => {
  if (depth > 32) throw ApiError.badRequest('PCB handoff is too deeply nested');
  if (Array.isArray(value)) return value.map((item) => canonical(item, depth + 1));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key], depth + 1)]));
  }
  return value;
};

const sourceHash = (source) => createHash('sha256').update(JSON.stringify(canonical(source))).digest('hex');

const validSvg = (value) => typeof value === 'string' && value.length <= MAX_SVG &&
  /^\s*<svg\s[^>]*xmlns=["']http:\/\/www\.w3\.org\/2000\/svg["']/i.test(value);

const boardMetadata = (chat, circuit) => {
  const items = JSON.parse(circuit);
  return {
    design_name: typeof chat.pcb_ir?.design_name === 'string' ? chat.pcb_ir.design_name.slice(0, 100) : 'Browser PCB preview',
    out_dir: '',
    execution: 'browser',
    verified: false,
    urls: {
      pcbSvg: `/api/v1/chats/${chat._id}/browser-board/pcb`,
      schematicSvg: `/api/v1/chats/${chat._id}/browser-board/schematic`,
      circuitJson: `/api/v1/chats/${chat._id}/browser-board/circuit`,
    },
    sizes: {},
    stats: {
      elements: items.length,
      components: items.filter((item) => item.type === 'source_component').length,
      traces: items.filter((item) => item.type === 'pcb_trace').length,
      errors: items.filter((item) => item.type.endsWith('_error')).length,
      warnings: items.filter((item) => item.type.endsWith('_warning')).length,
      errorTypes: [...new Set(items.filter((item) => item.type.endsWith('_error')).map((item) => item.type))],
    },
    generated_at: new Date().toISOString(),
  };
};

export const saveBrowserBoard = async (chatId, user, body) => {
  const chat = await getChat(chatId, user);
  const { sourceIr, pcbSvg, schematicSvg, circuitJson } = body ?? {};
  if (!sourceIr || typeof sourceIr !== 'object' || Array.isArray(sourceIr) ||
      JSON.stringify(sourceIr).length > MAX_IR || sourceHash(sourceIr) !== sourceHash(chat.pcb_ir)) {
    throw ApiError.badRequest('The PCB handoff has changed. Refresh the chat before saving this preview.');
  }
  if (!validSvg(pcbSvg) || !validSvg(schematicSvg) || !Array.isArray(circuitJson)) {
    throw ApiError.badRequest('Invalid browser board preview');
  }
  const circuit = JSON.stringify(circuitJson);
  if (circuit.length > MAX_JSON || circuitJson.length > 5000 ||
      circuitJson.some((item) => !item || typeof item !== 'object' || typeof item.type !== 'string')) {
    throw ApiError.badRequest('Invalid or oversized circuit JSON');
  }
  // One saved preview per chat bounds storage growth. The server still treats
  // the client-supplied geometry and error list as unverified data.
  const board = boardMetadata(chat, circuit);
  await mongoose.connection.transaction(async (session) => {
    const updated = await Chat.updateOne(
      { _id: chat._id, user: user._id, pcb_ir: chat.pcb_ir },
      { $set: { board } },
      { session },
    );
    if (!updated.modifiedCount) throw ApiError.conflict('The PCB handoff changed during generation. Refresh and try again.');
    await BrowserBoard.findOneAndUpdate(
      { chat: chat._id },
      { $set: { project: chat.project, user: user._id, sourceHash: sourceHash(sourceIr), pcbSvg, schematicSvg, circuitJson: circuit } },
      { upsert: true, new: true, runValidators: true, session },
    );
  });
  return board;
};

export const getBrowserBoardFile = async (chatId, user, kind) => {
  const field = FILES[kind];
  if (!field) throw ApiError.notFound('Board file not found');
  await getChat(chatId, user);
  const board = await BrowserBoard.findOne({ chat: chatId, user: user._id }).select(field).lean();
  if (!board?.[field]) throw ApiError.notFound('Board file not found');
  return { data: board[field], type: kind === 'circuit' ? 'application/json' : 'image/svg+xml', kind };
};
