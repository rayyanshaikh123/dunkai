# Browser runtime deployment runbook

Use your existing frontend host, Node backend and MongoDB Atlas. The remaining AI engine is delivered as browser code and workers; there is no separate AI engine to host. `render.yaml` now describes a free Node API only. The previous paid engine/Redis/worker blueprint is preserved as `render.cloud.yaml` for the legacy cloud path. Do not apply a new blueprint to replace existing services blindly; for your hosted API, update its environment and redeploy it.

## 1. Existing Node backend

Keep the existing database and auth/encryption secrets. Set these in the host's environment dashboard:

```dotenv
NODE_ENV=production
BROWSER_COMPUTE_ONLY=true
BILLING_ENABLED=false
AI_QUEUE_ENABLED=false
GROQ_API_KEY=<operator-groq-key>
GROQ_BROWSER_MODEL=openai/gpt-oss-120b
MONGODB_URI=<existing-atlas-connection-string>
JWT_ACCESS_SECRET=<existing-secret>
JWT_REFRESH_SECRET=<existing-secret>
BYOK_ENCRYPTION_KEY=<existing-encryption-secret>
FRONTEND_URL=https://<your-frontend-host>
CLIENT_ORIGIN=https://<your-frontend-host>
COOKIE_SECURE=true
COOKIE_SAMESITE=lax
COOKIE_DOMAIN=
TRUST_PROXY=1
RATE_LIMIT_MAX=300
AUTH_RATE_LIMIT_MAX=10
```

Use a valid enabled Groq model for that account. The operator key can be omitted if all users use Groq BYOK. The API verifies/encrypts their keys in Settings. Only Groq is used by this browser pipeline, even if legacy Settings lists other providers.

Atlas must support transactions; startup verifies the replica set and creates the unique replay, wallet/ledger, monthly usage, message and board indexes before accepting requests. Allow the Node host in Atlas network access. Preserve `BYOK_ENCRYPTION_KEY` when redeploying. No supervisor token, Redis URL or AI worker is needed in browser mode.

Configure at least one working verified sign-in route: SMTP for registration, verification and password reset, or Google OAuth for Google sign-in. Google callback should use the frontend rewrite: `https://<your-frontend-host>/api/v1/auth/google/callback`. SMTP uses `EMAIL_HOST`, `EMAIL_PORT`, `EMAIL_USER`, `EMAIL_PASS`, `EMAIL_FROM`; Google uses `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`. With neither configured, do not expect unverified accounts to receive hosted free requests.

Render backend root is `backend`, build `npm ci --omit=dev`, start `npm start`, Node 22, health `/health`. The existing free service may sleep; allow its first request to wake it before testing a design. Browser board files are private Atlas records, not files on an ephemeral API disk. Text references stay in browser memory and the saved model request/project context.

Locally the Node app loads `backend/.env` by default. **It does not automatically load `backend/.env.local`.** Set `DOTENV_CONFIG_PATH=.env.local npm run dev` from `backend/` to use that file, or copy intended values into `.env`. Host dashboard variables take precedence.

## 2. Existing frontend (Vercel)

Project root: `frontend`. Build command: `npm run build`. Set all four variables before rebuilding:

```dotenv
BACKEND_URL=https://<your-node-backend-host>
NEXT_PUBLIC_BACKEND_URL=https://<your-node-backend-host>
NEXT_PUBLIC_SITE_URL=https://<your-frontend-host>
NEXT_PUBLIC_BROWSER_COMPUTE_ONLY=true
```

Do not put a Groq key, Atlas URI, Stripe secret or encryption key into frontend variables. The `/api` rewrite uses `BACKEND_URL` at build time; cookies remain first-party on the frontend domain. Rebuilding is required after changing these variables. The prebuild prepares the PCB worker and downloads the pinned compiler assets, verifies their SHA-256 hashes and publishes compressed WASM files under `/vendor/avr/`. The toolchain source/license links ship with those files.

## 3. Verify the deployed path

1. Visit API `/health`, then sign in through the deployed frontend. Confirm the backend is awake and cookies persist.
2. Check `/api/v1/billing/plans`: `meteringEnabled: true`, `billingEnabled: false`, five monthly free requests and browser inference rate two credits.
3. Create a project. Start with a small resistor/NE555 design; accept the computation confirmation. Inspect browser Network: only `/ai/browser-inference`, project/chat storage and public catalogue calls. No `/ai/run-stream`, supervisor or server firmware compile request should occur.
4. Confirm requirements, architecture, BOM, PCB previews, validation findings and docs appear. Reload; the private artifacts should persist. Try another account; its API must not return the first account's board.
5. For a catalogue-backed ATMEGA328P-AU design, verify firmware appears. Compile an Uno target; download HEX. Physical upload requires a compatible board, reviewed source and a Web Serial browser. ESP32/RP2040 source upload requires preinstalled MicroPython.
6. Download the project review ZIP and inspect its PCB IR, Circuit JSON, SVGs, BOM and source files. Manufacturing approval/Gerbers are deliberately unavailable.
7. Cancel or refresh during a run, then resume. Completed model answers should be reused. A new request is needed for an explicitly failed model call, and already incurred provider usage cannot be undone.
8. Confirm five hosted model requests exhaust the monthly free allowance; the sixth returns 402 without invoking Groq when credits are unavailable. BYOK remains available and uses its own provider quota.

## 4. Enable purchases when ready

The free model quota runs with Stripe disabled. To sell credits, configure the existing INR Stripe account and test Checkout plus signed webhook delivery before setting `BILLING_ENABLED=true`. Use `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` on the Node API only. Webhook path: `/api/v1/billing/webhook`. Event types: `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `charge.refunded`, `charge.dispute.created`.

Test pack amounts, duplicate webhook replay, invalid signatures, refunds and disputes against the real test account. Credit grants come only from verified server webhook handling. Browser success redirects grant nothing. Keep SMTP configured for account recovery if purchases are enabled. Measure Groq usage and merchant fees before describing a profit margin. Existing packs: 200 credits/₹200, 500/₹500, 1500/₹1500. Each design uses two credits for one model request or four when a firmware request also applies, after the monthly free allowance. Local compute and BYOK use zero DunkAI credits.

## Checks in the repository

From `backend/`: `npm run test:credits`, `npm run test:browser-compute`, `npm run test:browser-free`. These use disposable MongoDB replica sets and mocked provider/payment responses.

From `frontend/`: `npm run typecheck`, `npm run test:browser-pcb`, `NEXT_PUBLIC_BROWSER_COMPUTE_ONLY=true npm run build`. Install the target Playwright browsers before `NEXT_PUBLIC_BROWSER_COMPUTE_ONLY=true npm run test:e2e -- --project=chromium`. A running server can be used with `PLAYWRIGHT_BASE_URL`; it must be a browser-mode build for the workspace test. CI includes Chromium/Firefox/WebKit on Windows/macOS/Linux.

Optional live provider smoke: `LIVE_GROQ_BROWSER_TEST=true PLAYWRIGHT_BASE_URL=http://127.0.0.1:3100 npm run test:e2e -- --project=chromium --grep 'live Groq'`. This permits one actual model request using the Node environment key, validates the real answer and routes its board in the browser. It uses provider quota and is skipped in ordinary tests/CI. The test runner keeps the key outside the browser.

See [BROWSER_COMPUTE_PLAN.md](BROWSER_COMPUTE_PLAN.md) for implemented limits and test evidence. Existing free hosts cover the compute deployment baseline; remote Groq usage, service quotas, external catalogue availability and physical hardware still impose practical limits.
