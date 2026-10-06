import { Router } from 'express';
import * as c from '../controllers/chat.controller.js';
import * as browserBoard from '../controllers/browserBoard.controller.js';
import { authenticate } from '../middleware/auth.js';
import { validate } from '../middleware/validation.js';
import { aiLimiter } from '../middleware/security.js';
import {
  createChatValidation,
  sendMessageValidation,
  renameChatValidation,
} from '../validators/chat.validators.js';

export const chatRoutes = Router();

chatRoutes.use(authenticate);

chatRoutes.post('/', createChatValidation, validate, c.create);
chatRoutes.get('/project/:projectId', c.list);
chatRoutes.get('/:id', c.get);
chatRoutes.get('/:id/messages', c.messages);
chatRoutes.post('/:id/browser-board', aiLimiter, browserBoard.save);
chatRoutes.get('/:id/browser-board/:kind', browserBoard.file);
chatRoutes.post('/:id/messages', sendMessageValidation, validate, c.sendMessage);
chatRoutes.post('/:id/messages/save', c.saveMessage);
chatRoutes.patch('/:id', renameChatValidation, validate, c.rename);
chatRoutes.patch('/:id/artifacts', c.updateArtifacts);
chatRoutes.post('/:id/pin', c.togglePin);
chatRoutes.delete('/:id/messages', c.clearMessages);
chatRoutes.delete('/:id', c.remove);
