import { Router } from 'express';
import { body, query } from 'express-validator';
import * as c from '../controllers/billing.controller.js';
import { authenticate } from '../middleware/auth.js';
import { validate } from '../middleware/validation.js';
import { CREDIT_PACKS } from '../config/credits.js';

export const billingRoutes = Router();

billingRoutes.get('/plans', c.plans);
billingRoutes.use(authenticate);
billingRoutes.get('/usage', c.usage);
billingRoutes.get('/wallet', c.wallet);
billingRoutes.get('/entries', c.entries);
billingRoutes.get('/quote', query('action').isString().notEmpty(), query('byok').optional().isBoolean(), query('chatId').optional().isMongoId(), validate, c.quote);
billingRoutes.post('/checkout', body('packId').isIn(Object.keys(CREDIT_PACKS)), validate, c.checkout);
billingRoutes.post('/reconcile', body('sessionId').optional().isString().isLength({ max: 255 }).matches(/^cs_[A-Za-z0-9_]+$/), validate, c.reconcile);
