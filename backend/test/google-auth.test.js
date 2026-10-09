import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { OAuth2Client } from 'google-auth-library';
import { env } from '../src/config/env.js';
import { User } from '../src/models/User.js';
import { Session } from '../src/models/Session.js';
import { ActivityLog } from '../src/models/ActivityLog.js';
import { handleGoogleCallback, getGoogleAuthUrl } from '../src/services/auth.service.js';
import { googleAuth, googleCallback } from '../src/controllers/auth.controller.js';
import { GOOGLE_STATE_COOKIE, googleStateCookieOptions, createGoogleState } from '../src/utils/googleOAuth.js';

// Real JWT signatures and the real Google verifier, with local public keys.
// Model methods are stubbed so these security regressions need no database.
const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const otherKeys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const nonce = createGoogleState();
let users, queries, saves, creates, sessions, tokenData, upstreamRequests;

function idToken(overrides = {}, signingKey = keys.privateKey) {
  const now = Math.floor(Date.now() / 1000);
  return jwt.sign({
    iss: 'https://accounts.google.com', aud: env.googleClientId,
    iat: now, exp: now + 3600, sub: 'google-subject-123', nonce,
    email: 'owner@gmail.com', email_verified: true, name: 'Google User',
    ...overrides,
  }, signingKey, { algorithm: 'RS256', keyid: 'local-google-key' });
}

beforeEach((t) => {
  users = []; queries = []; saves = []; creates = []; sessions = []; upstreamRequests = [];
  tokenData = { id_token: idToken(), access_token: 'unused-access-token' };
  t.mock.method(OAuth2Client.prototype, 'getFederatedSignonCertsAsync', async () => ({
    certs: { 'local-google-key': keys.publicKey.export({ type: 'spki', format: 'pem' }) },
  }));
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    upstreamRequests.push({ url, options });
    assert.equal(url, 'https://oauth2.googleapis.com/token');
    assert.equal(options.body.get('client_id'), env.googleClientId);
    return Response.json(tokenData);
  });
  t.mock.method(User, 'findOne', async (query) => {
    queries.push(query);
    return users.find((user) => Object.entries(query).every(([key, value]) => user[key] === value)) || null;
  });
  t.mock.method(User, 'create', async (values) => {
    creates.push(values);
    const user = new User(values);
    users.push(user);
    return user;
  });
  t.mock.method(User.prototype, 'save', async function () { saves.push(this); return this; });
  t.mock.method(Session, 'countDocuments', async () => 0);
  t.mock.method(Session.prototype, 'save', async function () { sessions.push(this); return this; });
  t.mock.method(ActivityLog, 'create', async () => ({}));
});

const callback = () => handleGoogleCallback('google-code', null, { nonce });

for (const [label, overrides, signingKey] of [
  ['unverified email', { email_verified: false }],
  ['missing email verification', { email_verified: undefined }],
  ['string email verification', { email_verified: 'true' }],
  ['missing subject', { sub: undefined }],
  ['malformed email', { email: 'not-an-email' }],
  ['wrong audience', { aud: 'another-client' }],
  ['wrong issuer', { iss: 'https://attacker.example' }],
  ['expired token', { iat: 1, exp: 2 }],
  ['wrong nonce', { nonce: 'other-login' }],
  ['missing nonce', { nonce: undefined }],
  ['invalid signature', {}, otherKeys.privateKey],
]) {
  test(`rejects ${label} before any account lookup, mutation or session`, async () => {
    tokenData.id_token = idToken(overrides, signingKey);
    await assert.rejects(callback(), { statusCode: 401 });
    assert.equal(queries.length + creates.length + saves.length + sessions.length, 0);
  });
}

test('requires an ID token instead of accepting access-token user info', async () => {
  delete tokenData.id_token;
  await assert.rejects(callback(), { statusCode: 401 });
  assert.equal(queries.length + creates.length + sessions.length, 0);
});

test('creates a verified Gmail account from the signed identity and issues a session', async () => {
  tokenData.id_token = idToken({ email: 'Owner@Gmail.com' });
  const result = await callback();
  assert.equal(result.user.email, 'owner@gmail.com');
  assert.equal(result.user.isVerified, true);
  assert.equal(result.user.googleId, 'google-subject-123');
  assert.equal(result.user.provider, 'google');
  assert.equal(sessions.length, 1);
  assert.ok(result.accessToken);
  assert.equal(upstreamRequests.length, 1);
});

test('verifies and links an active local Gmail account, clearing stale verification tokens', async () => {
  const user = new User({ name: 'Local User', email: 'owner@gmail.com', provider: 'local',
    password: 'existing-password-hash', emailVerificationToken: 'old-hash', emailVerificationExpires: new Date() });
  users.push(user);
  const result = await callback();
  assert.equal(result.user.isVerified, true);
  assert.equal(user.provider, 'local');
  assert.equal(user.password, 'existing-password-hash');
  assert.equal(user.googleId, 'google-subject-123');
  assert.equal(user.emailVerificationToken, undefined);
  assert.equal(user.emailVerificationExpires, undefined);
  assert.equal(creates.length, 0);
});

test('verified Google Workspace accounts can verify and link their mailbox', async () => {
  users.push(new User({ name: 'Workspace User', email: 'owner@company.test', provider: 'local' }));
  tokenData.id_token = idToken({ email: 'owner@company.test', hd: 'company.test' });
  const result = await callback();
  assert.equal(result.user.isVerified, true);
  assert.equal(result.user.googleId, 'google-subject-123');
});

test('third-party Google mailbox signups remain unverified', async () => {
  tokenData.id_token = idToken({ email: 'owner@third-party.test' });
  const result = await callback();
  assert.equal(result.user.isVerified, false);
  assert.equal(result.user.provider, 'google');
  assert.equal(sessions.length, 1);
});

test('a third-party Google email cannot link to an existing password account', async () => {
  const user = new User({ name: 'Local User', email: 'owner@third-party.test', provider: 'local', isVerified: true });
  users.push(user);
  tokenData.id_token = idToken({ email: user.email });
  await assert.rejects(callback(), { statusCode: 401 });
  assert.equal(user.googleId, undefined);
  assert.equal(saves.length + creates.length + sessions.length, 0);
});

test('a different Google subject cannot log into or overwrite an email-matched account', async () => {
  const user = new User({ name: 'Original User', email: 'owner@gmail.com', googleId: 'another-subject', isVerified: false });
  users.push(user);
  await assert.rejects(callback(), { statusCode: 401 });
  assert.equal(user.googleId, 'another-subject');
  assert.equal(user.isVerified, false);
  assert.equal(saves.length + creates.length + sessions.length, 0);
});

test('returning users are resolved by subject even when their Google email changed', async () => {
  const original = new User({ name: 'Original User', email: 'previous@gmail.com', googleId: 'google-subject-123', isVerified: false });
  const unrelated = new User({ name: 'Other User', email: 'owner@gmail.com', isVerified: true });
  users.push(original, unrelated);
  const result = await callback();
  assert.equal(String(result.user._id), String(original._id));
  assert.equal(result.user.email, 'previous@gmail.com');
  assert.equal(original.isVerified, false);
  assert.equal(unrelated.googleId, undefined);
  assert.deepEqual(queries, [{ googleId: 'google-subject-123' }]);
});

test('returning Google users with a matching authoritative email become verified', async () => {
  users.push(new User({ name: 'Returning User', email: 'owner@gmail.com', googleId: 'google-subject-123', isVerified: false }));
  assert.equal((await callback()).user.isVerified, true);
});

test('deactivated accounts are rejected before linking or verification', async () => {
  const user = new User({ name: 'Inactive User', email: 'owner@gmail.com', isActive: false });
  users.push(user);
  await assert.rejects(callback(), { statusCode: 403 });
  assert.equal(user.googleId, undefined);
  assert.equal(user.isVerified, false);
  assert.equal(saves.length + creates.length + sessions.length, 0);
});

function response() {
  return {
    cookies: [], cleared: [], location: '',
    headers: {},
    set(name, value) { this.headers[name] = value; },
    cookie(...args) { this.cookies.push(args); },
    clearCookie(...args) { this.cleared.push(args); },
    redirect(url) { this.location = url; },
  };
}
async function invoke(controller, req, res) {
  await controller(req, res, (error) => { throw error; });
}

test('sign-in issues a ten-minute HttpOnly state cookie and a matching Google nonce', async () => {
  const res = response();
  await invoke(googleAuth, {}, res);
  const [cookie, value, options] = res.cookies[0];
  const url = new URL(res.location);
  assert.equal(cookie, GOOGLE_STATE_COOKIE);
  assert.match(value, /^[a-f0-9]{64}$/);
  assert.equal(options.httpOnly, true);
  assert.equal(options.sameSite, 'lax');
  assert.equal(options.maxAge, 600000);
  assert.equal(url.searchParams.get('state'), value);
  assert.equal(url.searchParams.get('nonce'), value);
  assert.equal(url.searchParams.get('scope'), 'openid email profile');
  assert.equal(res.headers['Cache-Control'], 'private, no-store');
  assert.throws(() => getGoogleAuthUrl(), { statusCode: 400 });
});

test('missing, mismatched and array-valued callback state never reaches Google or the database', async () => {
  for (const [state, cookie] of [[undefined, nonce], [nonce, undefined], ['0'.repeat(64), nonce], [[nonce], nonce], [nonce, [nonce]]]) {
    const res = response();
    await invoke(googleCallback, { query: { code: 'code', state, dunkai_callback_bridge: '1' }, cookies: { [GOOGLE_STATE_COOKIE]: cookie } }, res);
    assert.ok(new URL(res.location).searchParams.has('error'));
    assert.deepEqual(res.cleared[0], [GOOGLE_STATE_COOKIE, googleStateCookieOptions]);
    assert.equal(res.cookies.length, 0);
  }
  assert.equal(upstreamRequests.length + queries.length + sessions.length, 0);
});

test('the Render callback returns to the website before reading its state cookie or issuing a session', async () => {
  const res = response();
  await invoke(googleCallback, { query: { code: 'google-code', state: nonce, next: 'https://attacker.example' }, cookies: {} }, res);
  const url = new URL(res.location);
  assert.equal(url.origin, env.clientOrigin);
  assert.equal(url.pathname, '/api/v1/auth/google/callback');
  assert.equal(url.searchParams.get('code'), 'google-code');
  assert.equal(url.searchParams.get('state'), nonce);
  assert.equal(url.searchParams.get('dunkai_callback_bridge'), '1');
  assert.equal(url.searchParams.has('next'), false);
  assert.equal(res.headers['Cache-Control'], 'private, no-store');
  assert.equal(res.cookies.length + res.cleared.length + upstreamRequests.length + sessions.length + queries.length, 0);

  // Vercel rewrites this same-origin request to Node, carrying the cookie
  // originally set on the website. Only now can Google authentication run.
  const websiteRes = response();
  await invoke(googleCallback, { query: Object.fromEntries(url.searchParams), cookies: { [GOOGLE_STATE_COOKIE]: nonce } }, websiteRes);
  assert.equal(new URL(websiteRes.location).searchParams.get('success'), 'true');
  assert.equal(websiteRes.cookies.length, 2);
  assert.equal(websiteRes.cleared.length, 1);
  assert.equal(sessions.length, 1);
  assert.equal(upstreamRequests[0].options.body.get('redirect_uri'), env.googleRedirectUri);
});

test('the callback bridge cannot replace a missing or mismatched state cookie', async () => {
  for (const cookie of [undefined, '0'.repeat(64)]) {
    const res = response();
    await invoke(googleCallback, { query: { code: 'google-code', state: nonce, dunkai_callback_bridge: '1' }, cookies: { [GOOGLE_STATE_COOKIE]: cookie } }, res);
    const url = new URL(res.location);
    assert.equal(url.pathname, '/auth/callback');
    assert.ok(url.searchParams.has('error'));
    assert.equal(res.cookies.length + upstreamRequests.length + sessions.length + queries.length, 0);
  }
});

test('Google cancellation on Render is returned to the website once and shown without starting a session', async () => {
  const res = response();
  await invoke(googleCallback, { query: { error: 'access_denied', state: nonce }, cookies: {} }, res);
  const url = new URL(res.location);
  assert.equal(url.pathname, '/api/v1/auth/google/callback');
  assert.equal(url.searchParams.get('error'), 'access_denied');
  const websiteRes = response();
  await invoke(googleCallback, { query: Object.fromEntries(url.searchParams), cookies: { [GOOGLE_STATE_COOKIE]: nonce } }, websiteRes);
  assert.equal(new URL(websiteRes.location).searchParams.get('error'), 'Google sign-in was cancelled.');
  assert.equal(websiteRes.cookies.length + upstreamRequests.length + sessions.length, 0);
});

test('a valid callback sets auth cookies and redirects to the frontend', async () => {
  const res = response();
  await invoke(googleCallback, { query: { code: 'code', state: nonce }, cookies: { [GOOGLE_STATE_COOKIE]: nonce } }, res);
  const url = new URL(res.location);
  assert.equal(url.origin, env.clientOrigin);
  assert.equal(url.pathname, '/auth/callback');
  assert.equal(url.searchParams.get('success'), 'true');
  assert.equal(url.searchParams.has('verify_email'), false);
  assert.equal(res.cookies.length, 2);
});

test('a third-party Google signup is directed to mailbox verification', async () => {
  tokenData.id_token = idToken({ email: 'owner@third-party.test' });
  const res = response();
  await invoke(googleCallback, { query: { code: 'code', state: nonce }, cookies: { [GOOGLE_STATE_COOKIE]: nonce } }, res);
  assert.equal(new URL(res.location).searchParams.get('verify_email'), 'owner@third-party.test');
});

test('Google verification failures redirect with a useful error and no auth cookies', async () => {
  tokenData.id_token = idToken({ email_verified: false });
  const res = response();
  await invoke(googleCallback, { query: { code: 'code', state: nonce }, cookies: { [GOOGLE_STATE_COOKIE]: nonce } }, res);
  assert.match(new URL(res.location).searchParams.get('error'), /not verified/);
  assert.equal(res.cookies.length + sessions.length + queries.length, 0);
});
