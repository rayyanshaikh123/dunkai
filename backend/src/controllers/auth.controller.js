import { asyncHandler } from '../utils/asyncHandler.js';
import { send } from '../utils/response.js';
import * as service from '../services/auth.service.js';
import { setAuthCookies, clearAuthCookies, extractTokensFromCookies, signSocketToken } from '../utils/tokens.js';
import { env } from '../config/env.js';
import {
  GOOGLE_STATE_COOKIE, googleStateCookieOptions, createGoogleState, isValidGoogleState,
} from '../utils/googleOAuth.js';

// Helper: set cookies if the request came from a browser (Origin header matches frontend)
const shouldSetCookies = (req) => {
  const origin = req.headers.origin;
  return Boolean(origin && env.corsOrigins.includes(origin));
};

const respondWithTokens = (res, data, message, status = 200, setCookies = true) => {
  if (setCookies) {
    setAuthCookies(res, data.accessToken, data.refreshToken);
  }
  send(res, { status, message, data });
};

export const register = asyncHandler(async (req, res) => {
  const data = await service.register(req.body, req);
  respondWithTokens(res, data, 'Account created successfully', 201, shouldSetCookies(req));
});

export const login = asyncHandler(async (req, res) => {
  const data = await service.login(req.body, req);
  respondWithTokens(res, data, 'Logged in successfully', 200, shouldSetCookies(req));
});

export const refresh = asyncHandler(async (req, res) => {
  // Accept refresh token from body OR cookie
  const token = req.body.refreshToken || extractTokensFromCookies(req).refreshToken;
  if (!token) {
    return send(res, { status: 400, message: 'Refresh token is required' });
  }
  const data = await service.refresh(token, req);
  respondWithTokens(res, data, 'Token refreshed successfully', 200, shouldSetCookies(req));
});

export const logout = asyncHandler(async (req, res) => {
  const token = req.body.refreshToken || extractTokensFromCookies(req).refreshToken;
  await service.logout(token, req);
  clearAuthCookies(res);
  send(res, { message: 'Logged out successfully' });
});

export const me = asyncHandler(async (req, res) => {
  send(res, { data: service.getCurrentUser(req.user) });
});

// GET /api/v1/auth/socket-token — see signSocketToken for why this exists.
export const socketToken = asyncHandler(async (req, res) => {
  res.set('Cache-Control', 'no-store');
  send(res, { data: { token: signSocketToken(req.user) } });
});

export const updateProfile = asyncHandler(async (req, res) => {
  const data = await service.updateProfile(req.user, req.body, req);
  send(res, { message: 'Profile updated successfully', data });
});

export const forgotPassword = asyncHandler(async (req, res) => {
  await service.forgotPassword(req.body.email, req);
  send(res, {
    message: 'If an account exists for that email, a reset link has been sent.',
  });
});

export const resetPassword = asyncHandler(async (req, res) => {
  const data = await service.resetPassword(req.body.token, req.body.password, req);
  respondWithTokens(res, data, 'Password reset successfully', 200, shouldSetCookies(req));
});

export const changePassword = asyncHandler(async (req, res) => {
  await service.changePassword(req.user, req.body.currentPassword, req.body.newPassword, req);
  send(res, { message: 'Password changed successfully' });
});

export const verifyEmail = asyncHandler(async (req, res) => {
  const result = await service.verifyEmail(req.body.token);
  send(res, { message: 'Email verified successfully', data: result });
});

export const resendVerification = asyncHandler(async (req, res) => {
  await service.resendVerification(req.body.email);
  send(res, { message: 'If the account exists, a new verification link has been sent.' });
});

// ---- Google OAuth ----

export const googleAuth = asyncHandler(async (req, res) => {
  res.set('Cache-Control', 'private, no-store');
  const state = createGoogleState();
  const url = service.getGoogleAuthUrl(state);
  res.cookie(GOOGLE_STATE_COOKIE, state, { ...googleStateCookieOptions, maxAge: 10 * 60 * 1000 });
  res.redirect(url);
});

export const googleCallback = asyncHandler(async (req, res) => {
  res.set('Cache-Control', 'private, no-store');
  const { code, error, state } = req.query;
  const expectedState = req.cookies?.[GOOGLE_STATE_COOKIE];

  // Existing Google clients may register the Render callback while sign-in
  // starts through Vercel. The state cookie belongs to Vercel. Return the
  // callback there once before checking it, exchanging the code, or issuing
  // auth cookies. The code exchange still uses Google's registered URI.
  const websiteCallback = new URL('/api/v1/auth/google/callback', env.clientOrigin);
  if (!expectedState && req.query.dunkai_callback_bridge === undefined &&
      new URL(env.googleRedirectUri).origin !== websiteCallback.origin &&
      isValidGoogleState(state, state) &&
      ((typeof code === 'string' && code) || (typeof error === 'string' && error))) {
    websiteCallback.searchParams.set('state', state);
    if (typeof code === 'string' && code) websiteCallback.searchParams.set('code', code);
    if (typeof error === 'string' && error) websiteCallback.searchParams.set('error', error);
    websiteCallback.searchParams.set('dunkai_callback_bridge', '1');
    return res.redirect(websiteCallback.toString());
  }

  res.clearCookie(GOOGLE_STATE_COOKIE, googleStateCookieOptions);
  const failure = (message) => res.redirect(`${env.clientOrigin}/auth/callback?error=${encodeURIComponent(message)}`);
  if (!isValidGoogleState(state, expectedState)) {
    return failure('Google sign-in has expired or did not start in this browser. Please try again.');
  }
  if (error) {
    return failure(error === 'access_denied' ? 'Google sign-in was cancelled.' : 'Google sign-in failed. Please try again.');
  }
  if (typeof code !== 'string' || !code) {
    return failure('Google did not return a sign-in code. Please try again.');
  }

  let data;
  try {
    data = await service.handleGoogleCallback(code, req, { nonce: state });
  } catch (err) {
    if (err.isOperational && err.statusCode < 500) return failure(err.message);
    throw err;
  }
  // Set cookies and redirect to frontend
  setAuthCookies(res, data.accessToken, data.refreshToken);

  // Redirect to frontend with success indicator
  const verification = data.user.isVerified ? '' : `&verify_email=${encodeURIComponent(data.user.email)}`;
  const redirectUrl = `${env.clientOrigin}/auth/callback?success=true${verification}`;
  res.redirect(redirectUrl);
});
