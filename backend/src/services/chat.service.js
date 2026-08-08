import { Chat } from '../models/Chat.js';
import { Message } from '../models/Message.js';
import { ApiError } from '../utils/ApiError.js';
import { getProject } from './project.service.js';
import { callSupervisor } from './supervisor.service.js';
import { parsePagination, buildPaginatedResponse } from '../helpers/pagination.js';
import { logActivity } from '../helpers/activity.js';

// ---- Get a chat owned by the user ----

const getOwnedChat = async (id, user) => {
  const chat = await Chat.findOne({ _id: id, user: user._id });
  if (!chat) throw ApiError.notFound('Chat not found');
  return chat;
};

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

  // Store user message
  const userMessage = await Message.create({
    chat: chat._id,
    sender: user._id,
    type: 'user',
    content,
    attachments,
  });

  // Fetch recent conversation history for context
  const priorMessages = await Message.find({ chat: chat._id })
    .sort({ createdAt: 1 })
    .limit(50)
    .select('type content metadata');

  // Call the Supervisor Agent (Python AI server)
  let assistantContent = '';
  let assistantMetadata = {};

  try {
    const result = await callSupervisor({
      action: agentType || 'chat',
      project: chat.project,
      messages: [...priorMessages].map((m) => ({ type: m.type, content: m.content })),
      files: attachments,
    });

    assistantContent = result.message || result.content || result.response || JSON.stringify(result);
    assistantMetadata = result;
  } catch (error) {
    assistantContent = 'I apologize, but I encountered an error processing your request. Please try again.';
    assistantMetadata = { error: error.message };
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

// ---- Delete chat ----

export const deleteChat = async (id, user) => {
  const chat = await getOwnedChat(id, user);
  await chat.deleteOne();
  await Message.deleteMany({ chat: id });
  return chat;
};

// ---- Pin/unpin chat ----

export const togglePin = async (id, user) => {
  const chat = await getOwnedChat(id, user);
  chat.pinned = !chat.pinned;
  await chat.save();
  return { pinned: chat.pinned };
};
