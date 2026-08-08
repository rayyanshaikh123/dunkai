import { asyncHandler } from '../utils/asyncHandler.js';
import { send } from '../utils/response.js';
import * as service from '../services/chat.service.js';

export const create = asyncHandler(async (req, res) => {
  send(res, { status: 201, message: 'Chat created', data: await service.createChat(req.body, req.user) });
});

export const list = asyncHandler(async (req, res) => {
  send(res, { data: await service.listChats(req.params.projectId, req.user, req.query) });
});

export const messages = asyncHandler(async (req, res) => {
  send(res, { data: await service.getMessages(req.params.id, req.user, req.query) });
});

export const sendMessage = asyncHandler(async (req, res) => {
  send(res, {
    status: 201,
    message: 'Message sent',
    data: await service.sendMessage(req.params.id, req.body, req.user, req),
  });
});

export const saveMessage = asyncHandler(async (req, res) => {
  send(res, {
    status: 201,
    message: 'Message saved',
    data: await service.saveMessage(req.params.id, req.body, req.user),
  });
});

export const rename = asyncHandler(async (req, res) => {
  send(res, { message: 'Chat renamed', data: await service.renameChat(req.params.id, req.body.title, req.user) });
});

export const remove = asyncHandler(async (req, res) => {
  await service.deleteChat(req.params.id, req.user);
  send(res, { message: 'Chat deleted' });
});

export const togglePin = asyncHandler(async (req, res) => {
  send(res, { data: await service.togglePin(req.params.id, req.user) });
});
