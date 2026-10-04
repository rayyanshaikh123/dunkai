import { body } from 'express-validator';

export const createChatValidation = [
  body('project').isMongoId().withMessage('Valid project ID is required'),
  body('title').optional().isLength({ min: 1, max: 160 }).withMessage('Title must be 1-160 characters'),
];

export const sendMessageValidation = [
  body('content').isLength({ min: 1, max: 8000 }).withMessage('Message content is required (1-8000 chars)'),
  body('attachments').optional().isArray({ max: 5 }),
  body('agentType').optional().isIn(['chat']),
];

export const renameChatValidation = [
  body('title').trim().isLength({ min: 1, max: 160 }).withMessage('Title is required'),
];
