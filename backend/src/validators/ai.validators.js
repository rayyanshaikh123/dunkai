import { body } from 'express-validator';
import { BOARD_PROVIDER_IDS } from '../config/providers.js';

export const chatValidation = [
  body('projectId').isMongoId().withMessage('Valid project ID is required'),
  body('chatId').optional().isMongoId(),
  body('model').optional().isString().isLength({ max: 120 }),
  body('message').isLength({ min: 1, max: 8000 }).withMessage('Message must be 1-8000 characters'),
  body('agentType').optional().isString(),
  body('files').optional().isArray({ max: 5 }),
];

export const codeChatValidation = [
  body('projectId').isMongoId(),
  body('chatId').optional().isMongoId(),
  body('messages').isArray({ min: 1, max: 40 }),
  body('messages.*.role').isIn(['user', 'assistant']),
  body('messages.*.content').isString().isLength({ max: 8000 }),
  body('files').isArray({ max: 5 }),
  body('files.*.filename').isString().isLength({ max: 200 }),
  body('files.*.code').isString().isLength({ max: 60000 }),
  body('model').optional().isString().isLength({ max: 120 }),
];

export const runValidation = [
  body('projectId').isMongoId(),
  body('chatId').optional().isMongoId(),
  body('action').optional().isIn([
    'run_workflow', 'generate_requirements', 'generate_architecture', 'generate_components',
    'generate_eda', 'generate_pcb', 'generate_validation', 'generate_documentation',
    'generate_code', 'generate_board', 'revise_interfaces',
  ]),
  body('agentType').optional().isIn(['requirement', 'architecture', 'component', 'pcb', 'validation', 'documentation']),
  body('messages').optional().isArray({ max: 40 }),
  body('messages.*.role').optional().isIn(['user', 'assistant', 'human']),
  body('messages.*.content').optional().isString().isLength({ max: 8000 }),
  body('files').optional().isArray({ max: 5 }),
  // Board-generation provider chosen in the UI. The list mirrors
  // dunkai-designer's provider registry; an unknown name would be rejected
  // there anyway, but failing here gives the user a 400 instead of a job that
  // dies three stages in.
  body('provider').optional().isIn(['auto', ...BOARD_PROVIDER_IDS]),
  // Not enumerated here on purpose: which models a provider will run is the
  // designer's rule, not this layer's, and it enforces it (the anthropic
  // provider refuses anything above the 4.5 generation). Duplicating the list
  // would give two places to forget to update.
  body('model').optional().isString().isLength({ max: 120 }),
];

export const cancelValidation = [
  body('jobId').notEmpty().withMessage('Job ID is required'),
];
