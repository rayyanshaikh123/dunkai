import 'dotenv/config';

const required = (name, fallback) => process.env[name] ?? fallback;
const asBoolean = (val) => val === 'true' || val === '1';
const asNumber = (val) => Number(val) || 0;
const asList = (val) =>
  String(val || '')
    .split(',')
    .map((item) => item.trim().replace(/\/+$/, ''))
    .filter(Boolean);

/**
 * Express `trust proxy`: how many proxy hops sit in front of this process.
 * Hosted, there is always at least one (the platform's load balancer, and the
 * Next.js rewrite when API calls go through the frontend). Without it every
 * request appears to come from the proxy's IP, so the per-IP rate limiter
 * throttles all users as one.
 */
const asTrustProxy = (val, fallback) => {
  if (val === undefined || val === '') return fallback;
  if (val === 'true') return true;
  if (val === 'false') return false;
  return Number.isInteger(Number(val)) ? Number(val) : val;
};

const nodeEnv = required('NODE_ENV', 'development');
const isProduction = nodeEnv === 'production';
const isTest = nodeEnv === 'test';

export const env = Object.freeze({
  nodeEnv,
  isProduction,
  isTest,
  port: asNumber(required('PORT', '4000')),

  // Database
  mongoUri: required('MONGODB_URI', 'mongodb://127.0.0.1:27017/dunkai'),
  mongoDbName: process.env.MONGODB_DB_NAME || '',

  // JWT
  accessSecret: required('JWT_ACCESS_SECRET', 'dev-access-secret-change-me'),
  refreshSecret: required('JWT_REFRESH_SECRET', 'dev-refresh-secret-change-me'),
  accessTtl: required('ACCESS_TOKEN_TTL', '15m'),
  refreshTtl: required('REFRESH_TOKEN_TTL', '30d'),

  // Cookie. No domain by default: the browser scopes the cookie to the host
  // that set it, which is the frontend when API calls go through its /api
  // rewrite. Set COOKIE_DOMAIN only to share auth across subdomains.
  cookieDomain: process.env.COOKIE_DOMAIN || '',
  cookieSecure: asBoolean(process.env.COOKIE_SECURE || String(isProduction)),
  cookieSameSite: process.env.COOKIE_SAMESITE || 'lax',

  // Google OAuth
  googleClientId: process.env.GOOGLE_CLIENT_ID || '',
  googleClientSecret: process.env.GOOGLE_CLIENT_SECRET || '',
  googleRedirectUri: required(
    'GOOGLE_REDIRECT_URI',
    'http://localhost:4000/api/v1/auth/google/callback'
  ),

  // Frontend / CORS
  clientOrigin: required('FRONTEND_URL', 'http://localhost:3000').replace(/\/+$/, ''),
  clientOriginFallback: process.env.CLIENT_ORIGIN || 'http://localhost:3000',
  // Every origin allowed to call the API and open a socket. FRONTEND_URL and
  // CLIENT_ORIGIN are always included; CORS_ORIGINS adds preview deploys etc.
  corsOrigins: [
    ...new Set([
      required('FRONTEND_URL', 'http://localhost:3000'),
      process.env.CLIENT_ORIGIN || 'http://localhost:3000',
      ...asList(process.env.CORS_ORIGINS),
    ].map((origin) => origin.replace(/\/+$/, ''))),
  ],

  // Networking
  trustProxy: asTrustProxy(process.env.TRUST_PROXY, isProduction ? 1 : false),
  // Opt-in override for Node's resolver. Forcing public DNS breaks private
  // hostnames (docker-compose services, Railway/Render internal networking).
  dnsServers: asList(process.env.DNS_SERVERS),

  // Supervisor Agent (Python AI server)
  supervisorUrl: required('SUPERVISOR_AGENT_URL', 'http://127.0.0.1:8000'),
  supervisorPath: required('SUPERVISOR_AGENT_PATH', '/api/v1/supervisor'),
  supervisorToken: process.env.SUPERVISOR_AGENT_TOKEN || '',

  // BYOK: AES-256-GCM key for users' provider keys at rest. Any string; it is
  // hashed to 32 bytes. Rotating it makes stored keys unreadable (users re-enter).
  byokEncryptionKey: process.env.BYOK_ENCRYPTION_KEY || '',

  // Billing. Off by default, so local and self-hosted installs have no quotas.
  // The hosted service sets BILLING_ENABLED=true.
  billingEnabled: asBoolean(process.env.BILLING_ENABLED || 'false'),
  stripeSecretKey: process.env.STRIPE_SECRET_KEY || '',
  stripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET || '',
  redisUrl: process.env.REDIS_URL || '',
  aiQueueEnabled: asBoolean(process.env.AI_QUEUE_ENABLED || 'false'),

  // Cloudinary
  cloudinaryCloudName: process.env.CLOUDINARY_NAME || '',
  cloudinaryApiKey: process.env.CLOUDINARY_KEY || '',
  cloudinaryApiSecret: process.env.CLOUDINARY_SECRET || '',

  // File Uploads
  uploadDir: required('UPLOAD_DIR', 'uploads'),
  maxFileSize: asNumber(required('MAX_FILE_SIZE_MB', '25')) * 1024 * 1024,

  // Firmware compiler
  arduinoCliPath: process.env.ARDUINO_CLI_PATH || 'arduino-cli',
  firmwareWorkDir: process.env.FIRMWARE_WORK_DIR || '',
  firmwareCompileTimeoutMs: asNumber(process.env.FIRMWARE_COMPILE_TIMEOUT_MS || '300000'),

  // Email (placeholder for production SMTP)
  emailFrom: process.env.EMAIL_FROM || 'noreply@dunkai.io',
  emailHost: process.env.EMAIL_HOST || '',
  emailPort: asNumber(process.env.EMAIL_PORT || '587'),
  emailUser: process.env.EMAIL_USER || '',
  emailPass: process.env.EMAIL_PASS || '',

  // Security
  bcryptRounds: asNumber(required('BCRYPT_ROUNDS', '12')),

  // Rate limiting
  rateLimitWindowMs: asNumber(required('RATE_LIMIT_WINDOW_MS', String(15 * 60 * 1000))),
  rateLimitMax: asNumber(required('RATE_LIMIT_MAX', '300')),
  authRateLimitMax: asNumber(required('AUTH_RATE_LIMIT_MAX', '10')),

  // Reset token expiry (in minutes)
  resetTokenExpiry: asNumber(required('RESET_TOKEN_EXPIRY_MIN', '30')),
});

// Fail-fast guards for production
if (isProduction && (env.accessSecret.includes('change-me') || env.refreshSecret.includes('change-me'))) {
  throw new Error('JWT_ACCESS_SECRET and JWT_REFRESH_SECRET must be configured in production');
}
if (isProduction && !env.byokEncryptionKey) {
  throw new Error('BYOK_ENCRYPTION_KEY must be configured in production (encrypts users\' API keys at rest)');
}
if (isProduction && !env.supervisorToken) {
  throw new Error('SUPERVISOR_AGENT_TOKEN must be configured in production');
}
