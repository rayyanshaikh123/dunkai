import { Chat } from '../models/Chat.js';
import { Message } from '../models/Message.js';
import { ApiError } from '../utils/ApiError.js';
import { getProject } from './project.service.js';
import { callSupervisor } from './supervisor.service.js';
import { parsePagination, buildPaginatedResponse } from '../helpers/pagination.js';
import { logActivity } from '../helpers/activity.js';
import { v4 as uuidv4 } from 'uuid';
import { resolveCredentials } from './apiKey.service.js';
import { reserveCharge, settleCharge } from './credits.service.js';
import { env } from '../config/env.js';

// ---- Get a chat owned by the user ----

const getOwnedChat = async (id, user) => {
  const chat = await Chat.findOne({ _id: id, user: user._id });
  if (!chat) throw ApiError.notFound('Chat not found');
  return chat;
};

// Exported so other services (e.g. the AI run-stream handler, which needs to
// read/scope a run to one chat's own artifacts) can reuse the same
// ownership-checked lookup rather than querying Chat directly.
export const getChat = getOwnedChat;

// The pipeline-artifact fields this chat can independently hold — see
// Chat.js. Whitelisted so this endpoint can't be used to write arbitrary
// fields (title, pinned, etc already have their own routes).
const ARTIFACT_KEYS = [
  'requirements',
  'architecture',
  'bom',
  'eda_data',
  'pcb_ir',
  'validation',
  'handoff_validation',
  'documentation',
  'code_generation',
  'board',
];

// ---- Create chat ----

export const createChat = async (data, user) => {
  await getProject(data.project, user);
  const chat = await Chat.create({
    project: data.project,
    user: user._id,
    title: data.title || 'New chat',
  });
  return chat;
};

// ---- List chats for a project ----

export const listChats = async (projectId, user, query = {}) => {
  await getProject(projectId, user);
  const { page, limit, skip, sort } = parsePagination(query);

  const filter = { project: projectId, user: user._id };
  const [items, total] = await Promise.all([
    Chat.find(filter).sort({ ...sort, pinned: -1 }).skip(skip).limit(limit),
    Chat.countDocuments(filter),
  ]);

  return buildPaginatedResponse(items, total, { page, limit });
};

// ---- Get messages (paginated) ----

export const getMessages = async (chatId, user, query = {}) => {
  const chat = await getOwnedChat(chatId, user);
  const { page, limit, skip } = parsePagination(query);

  const filter = { chat: chat._id };
  const [items, total] = await Promise.all([
    Message.find(filter).sort({ createdAt: 1 }).skip(skip).limit(limit),
    Message.countDocuments(filter),
  ]);

  return buildPaginatedResponse(items, total, { page, limit });
};

// ---- Save message directly without triggering supervisor AI ----

export const saveMessage = async (chatId, { type = 'user', content, metadata = {}, options = [] }, user) => {
  const chat = await getOwnedChat(chatId, user);

  const message = await Message.create({
    chat: chat._id,
    sender: type === 'user' ? user._id : undefined,
    type,
    content,
    metadata: { ...metadata, options },
  });

  chat.messageCount += 1;
  chat.lastMessageAt = new Date();
  await chat.save();

  return message;
};

// ---- Send message (stores user message, calls supervisor, stores assistant reply) ----

export const sendMessage = async (chatId, { content, attachments = [], agentType }, user, req = null) => {
  const chat = await getOwnedChat(chatId, user);
  const jobId = uuidv4();
  const credentials = env.localRuntimeEnabled ? {} : await resolveCredentials(user._id);
  await reserveCharge(user, jobId, { action: 'chat', byok: Boolean(credentials.groq), chatId: chat._id, projectId: chat.project });

  // Store user message
  let userMessage;
  let priorMessages;
  try {
    userMessage = await Message.create({
      chat: chat._id,
      sender: user._id,
      type: 'user',
      content,
      attachments,
    });
    priorMessages = await Message.find({ chat: chat._id })
      .sort({ createdAt: 1 })
      .limit(50)
      .select('type content metadata');
  } catch (error) {
    await settleCharge(jobId, null);
    throw error;
  }

  // Call the Supervisor Agent (Python AI server)
  let assistantContent = '';
  let assistantMetadata = {};

  let result;
  try {
    result = await callSupervisor({
      action: 'chat',
      project: { ...(await getProject(chat.project, user, true)).toObject(), ...chat.toObject(), _id: chat.project },
      messages: [...priorMessages].map((m) => ({ type: m.type, content: m.content })),
      files: attachments,
      credentials,
      jobId,
      audit: { userId: user._id, projectId: chat.project, chatId: chat._id },
    });
  } catch (error) {
    await settleCharge(jobId, null);
    assistantContent = 'I apologize, but I encountered an error processing your request. Please try again.';
    assistantMetadata = { error: error.message };
  }
  if (result) {
    await settleCharge(jobId, result);
    assistantContent = result.message || result.content || result.response || JSON.stringify(result);
    assistantMetadata = result;
  }

  // Store assistant response
  const assistantMessage = await Message.create({
    chat: chat._id,
    type: 'assistant',
    content: assistantContent,
    metadata: assistantMetadata,
  });

  // Update chat stats
  chat.messageCount += 2;
  chat.lastMessageAt = new Date();
  await chat.save();

  await logActivity('ai_request', user._id, { chatId: chat._id, agentType: agentType || 'chat' }, req);

  return { userMessage, assistantMessage };
};

// ---- Rename chat ----

export const renameChat = async (id, title, user) => {
  const chat = await getOwnedChat(id, user);
  chat.title = title;
  await chat.save();
  return chat;
};

// ---- Update this chat's pipeline artifacts (requirements/architecture/etc) ----

export const updateArtifacts = async (id, data, user) => {
  if (env.billingEnabled) throw ApiError.forbidden('Design artifacts are saved by the server after each run');
  const chat = await getOwnedChat(id, user);
  for (const key of ARTIFACT_KEYS) {
    if (data[key] === undefined) continue;
    chat[key] = data[key];
    chat.markModified(key);
  }
  await chat.save();
  return chat;
};

// ---- Delete chat ----

export const deleteChat = async (id, user) => {
  const chat = await getOwnedChat(id, user);
  await chat.deleteOne();
  const { deleteRuntimeArtifacts } = await import('./runtimeStorage.service.js');
  await deleteRuntimeArtifacts({ chat: chat._id });
  await Message.deleteMany({ chat: id });
  return chat;
};

// ---- Clear all messages from a chat (New Chat) ----

export const clearMessages = async (chatId, user) => {
  const chat = await getOwnedChat(chatId, user);
  await Message.deleteMany({ chat: chat._id });
  chat.messageCount = 0;
  chat.lastMessageAt = new Date();
  await chat.save();
  return chat;
};

// ---- Pin/unpin chat ----

export const togglePin = async (id, user) => {
  const chat = await getOwnedChat(id, user);
  chat.pinned = !chat.pinned;
  await chat.save();
  return { pinned: chat.pinned };
};
