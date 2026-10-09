import bcrypt from 'bcryptjs';
import { env } from '../config/env.js';
import { User } from '../models/User.js';
import { Session } from '../models/Session.js';
import { ActivityLog } from '../models/ActivityLog.js';
import { ApiError } from '../utils/ApiError.js';
import { sendPasswordResetEmail, sendVerificationEmail } from '../helpers/email.js';
import { verifyGoogleIdentity } from '../utils/googleOAuth.js';
import {
  hashToken,
  signAccessToken,
  signRefreshToken,
  verifyRefreshToken,
  generateResetToken,
  generateVerificationToken,
} from '../utils/tokens.js';

// ---- Activity Logging Helper ----

const logActivity = (action, userId = null, details = {}, req = null) =>
  ActivityLog.create({
    user: userId,
    action,
    ipAddress: req?.ip || '',
    userAgent: req?.headers?.['user-agent'] || '',
    details,
  }).catch(() => {});

// ---- Core: Issue tokens + create session ----

const issueTokens = async (user, req = null) => {
  // Delete any existing sessions for this user beyond a reasonable limit
  const existingCount = await Session.countDocuments({ user: user._id });
  if (existingCount >= 5) {
    // Keep only the most recent 4 sessions
    const oldSessions = await Session.find({ user: user._id })
      .sort({ createdAt: -1 })
      .skip(4);
    await Session.deleteMany({ _id: { $in: oldSessions.map((s) => s._id) } });
  }

  // Create session document (not yet saved) so we have the _id for the refresh token
  const session = new Session({
    user: user._id,
    expiresAt: new Date(Date.now() + 30 * 86400000),
    userAgent: req?.headers?.['user-agent'] || '',
    ipAddress: req?.ip || '',
  });

  const refreshToken = signRefreshToken(user, session._id);
  session.tokenHash = hashToken(refreshToken);
  await session.save();

  return {
    user: user.toJSON(),
    accessToken: signAccessToken(user),
    refreshToken,
  };
};

// ---- Register ----

export const register = async ({ name, email, password }, req = null) => {
  const existing = await User.findOne({ email });
  if (existing) throw ApiError.badRequest('Email is already registered');

  const hashedPassword = await bcrypt.hash(password, env.bcryptRounds);
  const { rawToken, hashedToken: verificationToken } = generateVerificationToken();

  const user = await User.create({
    name,
    email,
    password: hashedPassword,
    emailVerificationToken: verificationToken,
    emailVerificationExpires: new Date(Date.now() + 24 * 60 * 60 * 1000),
    provider: 'local',
  });

  await sendVerificationEmail(email, rawToken);

  await logActivity('register', user._id, { method: 'local' }, req);
  return issueTokens(user, req);
};

// ---- Login ----

export const login = async ({ email, password }, req = null) => {
  const user = await User.findOne({ email }).select('+password');
  if (!user || !user.password) {
    throw ApiError.unauthorized('Invalid email or password');
  }

  const isMatch = await bcrypt.compare(password, user.password);
  if (!isMatch) throw ApiError.unauthorized('Invalid email or password');

  if (!user.isActive) throw ApiError.forbidden('Account is deactivated');

  user.lastLogin = new Date();
  await user.save();

  await logActivity('login', user._id, { method: 'local' }, req);
  return issueTokens(user, req);
};

// ---- Refresh Token ----

export const refresh = async (token, req = null) => {
  let payload;
  try {
    payload = verifyRefreshToken(token);
  } catch {
    throw ApiError.unauthorized('Invalid refresh token');
  }

  const session = await Session.findOne({
    _id: payload.sid,
    user: payload.sub,
    tokenHash: hashToken(token),
    expiresAt: { $gt: new Date() },
  });

  if (!session) throw ApiError.unauthorized('Refresh session expired or revoked');

  // Rotate: delete old session
  await session.deleteOne();

  const user = await User.findById(payload.sub);
  if (!user) throw ApiError.unauthorized('User not found');
  if (!user.isActive) throw ApiError.forbidden('Account is deactivated');

  return issueTokens(user, req);
};

// ---- Logout ----

export const logout = async (token, req = null) => {
  if (!token) return;
  let payload;
  try {
    payload = verifyRefreshToken(token);
  } catch {
    return; // Invalid token, nothing to revoke
  }
  await Session.deleteOne({ _id: payload.sid, tokenHash: hashToken(token) });

  if (payload.sub) {
    await logActivity('logout', payload.sub, {}, req);
  }
};

// ---- Get current user ----

export const getCurrentUser = (user) => user.toJSON();

// ---- Update Profile ----

export const updateProfile = async (user, { name, avatar } = {}, req = null) => {
  if (name !== undefined) user.name = name;
  if (avatar !== undefined) user.avatar = avatar;
  await user.save();

  await logActivity('profile_updated', user._id, {}, req);
  return user.toJSON();
};

// ---- Forgot Password ----

export const forgotPassword = async (email, req = null) => {
  const user = await User.findOne({ email });
  // Always return success to prevent email enumeration
  if (!user) return { sent: true };

  const { rawToken, hashedToken, expires } = generateResetToken();
  user.resetPasswordToken = hashedToken;
  user.resetPasswordExpires = expires;
  await user.save();

  await sendPasswordResetEmail(email, rawToken);

  await logActivity('password_reset', user._id, { requestedAt: new Date() }, req);
  return { sent: true };
};

// ---- Reset Password ----

export const resetPassword = async (token, newPassword, req = null) => {
  const hashedToken = hashToken(token);
  const user = await User.findOne({
    resetPasswordToken: hashedToken,
    resetPasswordExpires: { $gt: new Date() },
  }).select('+password +resetPasswordToken +resetPasswordExpires');

  if (!user) throw ApiError.badRequest('Invalid or expired reset token');

  user.password = await bcrypt.hash(newPassword, env.bcryptRounds);
  user.resetPasswordToken = undefined;
  user.resetPasswordExpires = undefined;
  await user.save();

  // Revoke all existing sessions (force re-login everywhere)
  await Session.deleteMany({ user: user._id });

  await logActivity('password_reset', user._id, { completedAt: new Date() }, req);
  return issueTokens(user, req);
};

// ---- Change Password (authenticated) ----

export const changePassword = async (user, currentPassword, newPassword, req = null) => {
  const userWithPassword = await User.findById(user._id).select('+password');
  if (!userWithPassword.password) {
    throw ApiError.badRequest('Password change not available for OAuth accounts');
  }

  const isMatch = await bcrypt.compare(currentPassword, userWithPassword.password);
  if (!isMatch) throw ApiError.unauthorized('Current password is incorrect');

  userWithPassword.password = await bcrypt.hash(newPassword, env.bcryptRounds);
  await userWithPassword.save();

  await logActivity('password_reset', user._id, { method: 'change' }, req);
  return { success: true };
};

// ---- Email Verification ----

export const verifyEmail = async (token) => {
  const hashedToken = hashToken(token);
  const user = await User.findOne({ emailVerificationToken: hashedToken, emailVerificationExpires: { $gt: new Date() } });
  if (!user) throw ApiError.badRequest('Invalid verification token');

  user.isVerified = true;
  user.emailVerificationToken = undefined;
  user.emailVerificationExpires = undefined;
  await user.save();

  return { verified: true };
};

export const resendVerification = async (email) => {
  const user = await User.findOne({ email });
  if (!user) return { sent: true };
  if (user.isVerified) return { sent: true };

  const { rawToken, hashedToken } = generateVerificationToken();
  user.emailVerificationToken = hashedToken;
  user.emailVerificationExpires = new Date(Date.now() + 24 * 60 * 60 * 1000);
  await user.save();

  await sendVerificationEmail(email, rawToken);
  return { sent: true };
};

// ---- Google OAuth ----

export const getGoogleAuthUrl = (state) => {
  if (!env.googleClientId || !env.googleClientSecret) {
    throw ApiError.badRequest('Google OAuth is not configured on the server');
  }
  if (typeof state !== 'string' || !/^[a-f0-9]{64}$/.test(state)) {
    throw ApiError.badRequest('Google sign-in must start from the sign-in page');
  }
  const params = new URLSearchParams({
    client_id: env.googleClientId,
    redirect_uri: env.googleRedirectUri,
    response_type: 'code',
    scope: 'openid email profile',
    access_type: 'offline',
    prompt: 'consent',
    state,
    nonce: state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
};

export const handleGoogleCallback = async (code, req = null, { nonce } = {}) => {
  if (!env.googleClientId || !env.googleClientSecret) {
    throw ApiError.badRequest('Google OAuth is not configured on the server');
  }
  if (typeof code !== 'string' || !code || typeof nonce !== 'string' || !nonce) {
    throw ApiError.unauthorized('Google sign-in must start from the sign-in page');
  }

  // Exchange code for tokens
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: env.googleClientId,
      client_secret: env.googleClientSecret,
      redirect_uri: env.googleRedirectUri,
      grant_type: 'authorization_code',
    }),
  });

  if (!tokenRes.ok) {
    const err = await tokenRes.json().catch(() => ({}));
    throw ApiError.unauthorized(`Google token exchange failed: ${err.error || 'unknown error'}`);
  }

  const tokenData = await tokenRes.json();
  const googleUser = await verifyGoogleIdentity(tokenData.id_token, nonce);

  // Google emails can change. Returning users belong to the stable subject,
  // never to whichever account happens to have their current Google email.
  let user = await User.findOne({ googleId: googleUser.sub });
  if (!user) {
    user = await User.findOne({ email: googleUser.email });
    if (user?.googleId && user.googleId !== googleUser.sub) {
      throw ApiError.unauthorized('This email is linked to a different Google account. Sign in using the original account.');
    }
    if (user && !googleUser.emailAuthoritative) {
      throw ApiError.unauthorized('Sign in with your existing password. Google cannot verify ownership of this third-party email address for account linking.');
    }
  }
  if (user && !user.isActive) throw ApiError.forbidden('Account is deactivated');

  if (!user) {
    const name = googleUser.name.trim() || googleUser.email.split('@')[0];
    user = await User.create({
      name: name.length >= 2 ? name.slice(0, 100) : 'Google user',
      email: googleUser.email,
      avatar: googleUser.picture || '',
      provider: 'google',
      googleId: googleUser.sub,
      isVerified: googleUser.emailAuthoritative,
    });
  } else if (!user.googleId) {
    // Link existing account to Google
    user.googleId = googleUser.sub;
    user.provider = user.provider === 'local' ? 'local' : 'google';
    if (googleUser.picture && !user.avatar) user.avatar = googleUser.picture;
  }

  // Verify only the application's stored email, not another address now
  // attached to the same Google account. Preserve prior mailbox verification.
  if (googleUser.emailAuthoritative && user.email === googleUser.email) {
    user.isVerified = true;
    user.emailVerificationToken = undefined;
    user.emailVerificationExpires = undefined;
  }

  user.lastLogin = new Date();
  await user.save();

  await logActivity('login', user._id, { method: 'google' }, req);
  return issueTokens(user, req);
};
