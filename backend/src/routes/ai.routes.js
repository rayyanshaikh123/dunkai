import { Router } from 'express';
import * as c from '../controllers/ai.controller.js';
import { authenticate } from '../middleware/auth.js';
import { validate } from '../middleware/validation.js';
import { aiLimiter, browserInferenceLimiter } from '../middleware/security.js';
import { env } from '../config/env.js';
import { ApiError } from '../utils/ApiError.js';
import { chatValidation, codeChatValidation, runValidation, cancelValidation, browserInferenceValidation } from '../validators/ai.validators.js';
import { browserInference } from '../controllers/browserInference.controller.js';

export const aiRoutes = Router();

aiRoutes.use(authenticate);
aiRoutes.use(aiLimiter);

aiRoutes.get('/providers', c.providers);
aiRoutes.post('/browser-inference', browserInferenceLimiter, browserInferenceValidation, validate, browserInference);
aiRoutes.use((req, _res, next) => next(env.browserComputeOnly
  ? new ApiError(503, 'The Python AI engine is disabled; use browser computation')
  : undefined));
aiRoutes.post('/chat', chatValidation, validate, c.chat);
aiRoutes.post('/code-chat', codeChatValidation, validate, c.codeChat);
aiRoutes.post('/run', runValidation, validate, c.run);
aiRoutes.post('/run-stream', runValidation, validate, c.runStream);
aiRoutes.get('/status/:id', c.status);
aiRoutes.get('/project/:projectId', c.projectArtifacts);
aiRoutes.post('/cancel', cancelValidation, validate, c.cancel);
