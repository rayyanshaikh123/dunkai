import { Server as SocketIOServer } from 'socket.io';
import { verifyAccessToken } from '../utils/tokens.js';
import { User } from '../models/User.js';
import { env } from '../config/env.js';
import { Project } from '../models/Project.js';
import { AiJob } from '../models/AiJob.js';
import { createAdapter } from '@socket.io/redis-adapter';
import { redisConnection } from '../services/queue.service.js';

/**
 * Initialize Socket.io server.
 * Supports: streaming AI responses, typing indicators, progress updates, notifications.
 */
export const initSocket = (httpServer) => {
  const io = new SocketIOServer(httpServer, {
    cors: {
      origin: env.corsOrigins,
      credentials: true,
      methods: ['GET', 'POST'],
    },
    pingTimeout: 60000,
    pingInterval: 25000,
  });
  if (env.aiQueueEnabled) {
    const pub = redisConnection();
    io.adapter(createAdapter(pub, pub.duplicate()));
  }

  // Socket authentication middleware
  io.use(async (socket, next) => {
    try {
      // Preferred: the short-lived socket token from GET /auth/socket-token,
      // which is the only thing that works when the frontend and this server
      // are on different domains (see signSocketToken in utils/tokens.js).
      let token = socket.handshake.auth?.token;

      // Fall back to the access cookie, which only arrives when both are on one host
      if (!token && socket.handshake.headers?.cookie) {
        const cookies = socket.handshake.headers.cookie
          .split(';')
          .reduce((acc, c) => {
            const [k, v] = c.trim().split('=');
            acc[k] = v;
            return acc;
          }, {});
        token = cookies['dunk_access'];
      }

      if (!token) {
        return next(new Error('Authentication required'));
      }

      const payload = verifyAccessToken(token);
      const user = await User.findById(payload.sub);
      if (!user || !user.isActive) {
        return next(new Error('Invalid user'));
      }

      socket.userId = user._id.toString();
      socket.user = user;
      next();
    } catch {
      next(new Error('Authentication failed'));
    }
  });

  io.on('connection', (socket) => {
    console.info(`[Socket] User connected: ${socket.userId}`);

    // Join personal room for notifications
    socket.join(`user:${socket.userId}`);

    // Join project rooms for collaborative features
    socket.on('project:join', async (projectId) => {
      if (!/^[a-f\d]{24}$/i.test(String(projectId))) return;
      const allowed = await Project.exists({ _id: projectId, $or: [
        { owner: socket.userId }, { 'members.user': socket.userId },
      ] });
      if (!allowed) return;
      socket.join(`project:${projectId}`);
      socket.to(`project:${projectId}`).emit('user:joined', {
        userId: socket.userId,
        name: socket.user.name,
      });
    });

    socket.on('project:leave', (projectId) => {
      if (!socket.rooms.has(`project:${projectId}`)) return;
      socket.leave(`project:${projectId}`);
      socket.to(`project:${projectId}`).emit('user:left', {
        userId: socket.userId,
      });
    });

    // Typing indicators
    socket.on('typing:start', ({ projectId, chatId }) => {
      if (!socket.rooms.has(`project:${projectId}`)) return;
      socket.to(`project:${projectId}`).emit('typing:start', {
        userId: socket.userId,
        name: socket.user.name,
        chatId,
      });
    });

    socket.on('typing:stop', ({ projectId, chatId }) => {
      if (!socket.rooms.has(`project:${projectId}`)) return;
      socket.to(`project:${projectId}`).emit('typing:stop', {
        userId: socket.userId,
        chatId,
      });
    });

    // AI progress updates (for streaming)
    socket.on('ai:subscribe', async (jobId) => {
      if (typeof jobId !== 'string') return;
      const job = await AiJob.findOne({ jobId, user: socket.userId });
      if (!job) return;
      socket.join(`job:${jobId}`);
      if (job.status === 'completed') socket.emit('ai:complete', { jobId, result: { jobId, data: job.result, status: 'completed' } });
      if (job.status === 'failed') socket.emit('ai:error', { jobId, error: { error: job.error || 'Job failed' } });
      if (job.status === 'cancelled') socket.emit('ai:error', { jobId, error: { error: job.error || 'Job cancelled' } });
      if (job.status === 'running' && job.progress) socket.emit('ai:progress', { ...job.progress, jobId });
    });

    socket.on('ai:unsubscribe', (jobId) => {
      socket.leave(`job:${jobId}`);
    });

    socket.on('disconnect', () => {
      console.info(`[Socket] User disconnected: ${socket.userId}`);
    });
  });

  return io;
};

/**
 * Emit a notification to a specific user (used by services/helpers).
 */
export const emitToUser = (io, userId, event, data) => {
  io.to(`user:${userId}`).emit(event, data);
};

/**
 * Emit AI progress update to subscribers of a job.
 */
export const emitAIProgress = (io, jobId, data) => {
  io.to(`job:${jobId}`).emit('ai:progress', data);
};

/**
 * Emit AI streaming chunk to subscribers.
 */
export const emitAIStream = (io, jobId, chunk) => {
  io.to(`job:${jobId}`).emit('ai:stream', { chunk, jobId });
};

/**
 * Emit AI completion to subscribers.
 */
export const emitAIComplete = (io, jobId, result) => {
  io.to(`job:${jobId}`).emit('ai:complete', { jobId, result });
};

/**
 * Emit AI error to subscribers when the pipeline fails mid-stream.
 */
export const emitAIError = (io, jobId, error) => {
  io.to(`job:${jobId}`).emit('ai:error', { jobId, error });
};
