import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import morgan from 'morgan';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import swaggerUi from 'swagger-ui-express';

import { env } from './config/env.js';
import { corsOptions, generalLimiter, sanitizeMongo } from './middleware/security.js';
import { notFound, errorHandler } from './middleware/error.js';
import { send } from './utils/response.js';
import { boardArtifact, uploadArtifact } from './controllers/artifact.controller.js';
import { authenticate } from './middleware/auth.js';

// Routes
import { authRoutes } from './routes/auth.routes.js';
import { projectRoutes } from './routes/project.routes.js';
import { chatRoutes } from './routes/chat.routes.js';
import { aiRoutes } from './routes/ai.routes.js';
import { fileRoutes } from './routes/file.routes.js';
import { documentRoutes } from './routes/document.routes.js';
import { notificationRoutes } from './routes/notification.routes.js';
import { accountRoutes } from './routes/account.routes.js';
import { billingRoutes } from './routes/billing.routes.js';
import { webhook as stripeWebhook } from './controllers/billing.controller.js';
import { firmwareRoutes } from './routes/firmware.routes.js';
import { openapi } from './docs/openapi.js';

export const app = express();

// Behind a load balancer (and the Next.js /api rewrite), req.ip is the proxy's
// unless this is set, and the per-IP rate limiter treats all users as one.
app.set('trust proxy', env.trustProxy);

// ---- Security & parsing middleware ----
app.use(helmet());
app.use(cors(corsOptions));
app.use(compression());
// Signature verification requires the exact bytes Stripe sent.
app.post('/api/v1/billing/webhook', express.raw({ type: 'application/json' }), stripeWebhook);
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(sanitizeMongo());

// Every local upload and board artifact requires project access. The old
// express.static mount disclosed private designs to anyone with a URL.
app.get('/uploads/boards/*', authenticate, boardArtifact);
app.get('/uploads/:name', authenticate, uploadArtifact);

// ---- Logging ----
app.use(morgan(env.isProduction ? 'combined' : 'dev'));

// ---- Rate limiting ----
app.use('/api/v1', generalLimiter);

// ---- Health check ----
app.get('/health', (_req, res) =>
  send(res, {
    data: {
      service: 'dunk-ai-backend',
      name: 'Dunk AI',
      version: '1.0.0',
      status: 'ok',
      timestamp: new Date().toISOString(),
    },
  })
);

// ---- API Documentation ----
app.use('/docs', swaggerUi.serve, swaggerUi.setup(openapi, { explorer: true }));

// ---- API Routes v1 ----
app.use('/api/v1/auth', authRoutes);
app.use('/api/v1/projects', projectRoutes);
app.use('/api/v1/chats', chatRoutes);
app.use('/api/v1/ai', aiRoutes);
app.use('/api/v1/files', fileRoutes);
app.use('/api/v1/documents', documentRoutes);
app.use('/api/v1/notifications', notificationRoutes);
app.use('/api/v1/account', accountRoutes);
app.use('/api/v1/billing', billingRoutes);
app.use('/api/v1/firmware', firmwareRoutes);

// ---- Error handling ----
app.use(notFound);
app.use(errorHandler);
