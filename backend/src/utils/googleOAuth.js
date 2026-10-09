import { randomBytes, timingSafeEqual } from 'node:crypto';
import { OAuth2Client } from 'google-auth-library';
import { env } from '../config/env.js';
import { ApiError } from './ApiError.js';

const googleClient = new OAuth2Client();
export const GOOGLE_STATE_COOKIE = 'dunkai_google_state';

export const googleStateCookieOptions = {
  httpOnly: true,
  secure: env.cookieSecure,
  // Google returns with a top-level GET, including through the Vercel rewrite.
  sameSite: 'lax',
  path: '/api/v1/auth/google',
  ...(env.cookieDomain ? { domain: env.cookieDomain } : {}),
};

export const createGoogleState = () => randomBytes(32).toString('hex');

export const isValidGoogleState = (received, expected) =>
  typeof received === 'string' && /^[a-f0-9]{64}$/.test(received) &&
  typeof expected === 'string' && /^[a-f0-9]{64}$/.test(expected) &&
  timingSafeEqual(Buffer.from(received), Buffer.from(expected));

export const verifyGoogleIdentity = async (idToken, nonce) => {
  if (typeof idToken !== 'string' || !idToken || typeof nonce !== 'string' || !nonce) {
    throw ApiError.unauthorized('Google sign-in could not be verified. Please try again.');
  }

  let claims;
  try {
    // The library checks Google's signature, issuer, audience and expiry,
    // and caches Google's rotating public certificates.
    const ticket = await googleClient.verifyIdToken({
      idToken,
      audience: env.googleClientId,
    });
    claims = ticket.getPayload();
  } catch {
    // Library errors can contain the raw token; do not expose or log them.
    throw ApiError.unauthorized('Google sign-in could not be verified. Please try again.');
  }

  if (claims?.nonce !== nonce) {
    throw ApiError.unauthorized('Google sign-in has expired. Please try again.');
  }
  if (claims.email_verified !== true) {
    throw ApiError.unauthorized('Google has not verified this email address. Verify it with Google before signing in.');
  }
  if (typeof claims.sub !== 'string' || !claims.sub.trim() || claims.sub.length > 255 ||
      typeof claims.email !== 'string' || claims.email.length > 320 ||
      !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(claims.email)) {
    throw ApiError.unauthorized('Google did not return a valid account ID and email address.');
  }

  const email = claims.email.toLowerCase();
  // Google cannot vouch for current mailbox ownership of third-party email
  // addresses, even when email_verified is true. They need our email flow.
  const emailAuthoritative = email.endsWith('@gmail.com') ||
    (typeof claims.hd === 'string' && Boolean(claims.hd.trim()));
  return {
    sub: claims.sub,
    email,
    name: typeof claims.name === 'string' ? claims.name : '',
    picture: typeof claims.picture === 'string' ? claims.picture : '',
    emailAuthoritative,
  };
};
