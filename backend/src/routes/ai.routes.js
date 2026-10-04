import { Router } from 'express';
import * as c from '../controllers/ai.controller.js';
import { authenticate } from '../middleware/auth.js';
import { validate } from '../middleware/validation.js';
import { aiLimiter } from '../middleware/security.js';
import { chatValidation, codeChatValidation, runValidation, cancelValidation } from '../validators/ai.validators.js';

export const aiRoutes = Router();

aiRoutes.use(authenticate);
aiRoutes.use(aiLimiter);

aiRoutes.get('/providers', c.providers);
aiRoutes.post('/chat', chatValidation, validate, c.chat);
aiRoutes.post('/code-chat', codeChatValidation, validate, c.codeChat);
aiRoutes.post('/run', runValidation, validate, c.run);
aiRoutes.post('/run-stream', runValidation, validate, c.runStream);
aiRoutes.get('/status/:id', c.status);
aiRoutes.get('/project/:projectId', c.projectArtifacts);
aiRoutes.post('/cancel', cancelValidation, validate, c.cancel);
