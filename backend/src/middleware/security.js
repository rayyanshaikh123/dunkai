import rateLimit from 'express-rate-limit';
import mongoSanitize from 'express-mongo-sanitize';
import { env } from '../config/env.js';
import { ApiError } from '../utils/ApiError.js';

// General API rate limiter
export const generalLimiter = rateLimit({
  windowMs: env.rateLimitWindowMs,
  limit: env.rateLimitMax,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: 'Too many requests, please try again later.',
    data: null,
    errors: [{ message: 'Rate limit exceeded' }],
  },
});

// Stricter limiter for auth endpoints
export const authLimiter = rateLimit({
  windowMs: env.rateLimitWindowMs,
  limit: env.authRateLimitMax,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: 'Too many authentication attempts, please try again later.',
    data: null,
    errors: [{ message: 'Auth rate limit exceeded' }],
  },
});

// Limiter for AI endpoints
export const aiLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: 'Too many AI requests, please slow down.',
    data: null,
    errors: [{ message: 'AI rate limit exceeded' }],
  },
});

export const browserInferenceLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 8,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => String(req.user._id),
  message: { success: false, message: 'Too many model requests. Try again shortly.' },
});

// Mongo sanitize to prevent NoSQL injection
export const sanitizeMongo = mongoSanitize;

// CORS configuration
export const corsOptions = {
  origin: (origin, callback) => {
    // Allow requests with no origin (mobile apps, curl, server-to-server)
    if (!origin) return callback(null, true);
    if (env.corsOrigins.includes(origin)) {
      callback(null, true);
    } else {
      // A 403, not a bare Error: that surfaced as a logged 500 "Server Error"
      // for every request from an origin not in CORS_ORIGINS.
      callback(ApiError.forbidden(`CORS: origin ${origin} not allowed`));
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
  exposedHeaders: ['Set-Cookie'],
  maxAge: 86400, // 24 hours
};
