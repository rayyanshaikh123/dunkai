import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import * as c from '../controllers/firmware.controller.js';
import { authenticate } from '../middleware/auth.js';
import { validate } from '../middleware/validation.js';
import { compileValidation, resolveValidation } from '../validators/firmware.validators.js';

const compileLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many compile requests, please wait a minute.', data: null, errors: [] },
});

export const firmwareRoutes = Router();

firmwareRoutes.use(authenticate);

firmwareRoutes.get('/boards', resolveValidation, validate, c.boards);
firmwareRoutes.post('/compile', compileLimiter, compileValidation, validate, c.compile);
firmwareRoutes.get('/builds/:buildId([a-f0-9]{64})/download', c.download);
