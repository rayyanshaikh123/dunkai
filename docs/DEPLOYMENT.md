# Deploying Dunk AI

For the current local AI-engine approach, use [LOCAL_RUNTIME.md](LOCAL_RUNTIME.md).
The dedicated-engine instructions below remain available for development with
`LOCAL_RUNTIME_ENABLED=false`.

Three services and a database:

| Service | Runtime | Needs |
| --- | --- | --- |
| `frontend/` | Next.js 16 | `BACKEND_URL`, `NEXT_PUBLIC_BACKEND_URL` at build time |
| `backend/` | Node 22, Express + Socket.io | MongoDB, the AI engine, WebSocket support |
| `ai_engine/` (+ `dunkai-designer/`) | Python 3.12 + Node 22 | ≥ 2 GB RAM, a disk for the dataset cache, `GROQ_API_KEY`, `HF_TOKEN_READ` |
| MongoDB | 7.x | Atlas or self-hosted |

Every service has an `.env.example` beside it. Copy it, fill it in, and never commit the result.

## Option A — one machine (Docker Compose)

The quickest full install, and the only option where the agentic `claude-code` board generator can work (install the `claude` CLI on the host image yourself; the default image does not include it).

```bash
cp backend/.env.example backend/.env        # JWT_*, BYOK_ENCRYPTION_KEY
cp ai_engine/.env.example ai_engine/.env    # GROQ_API_KEY, HF_TOKEN_READ
echo "SUPERVISOR_AGENT_TOKEN=$(openssl rand -hex 24)" > .env
docker compose up --build
```

Open http://localhost:3000. Boards are written to the shared `uploads` volume and served by the backend directly.

## Option B — managed hosts

A common split: **Vercel** for the frontend, **Render / Railway / Fly.io** for the backend and AI engine, **MongoDB Atlas** for the database.

### 1. AI engine

- Build with `ai_engine/Dockerfile` and the **repository root** as the build context (it copies `dunkai-designer/` too).
- Give it at least 2 GB of RAM (torch + sentence-transformers) and a persistent disk mounted at `/data` (dataset cache and generated boards).
- Set `GROQ_API_KEY`, `HF_TOKEN_READ`, `SUPERVISOR_AGENT_TOKEN`, and `DESIGNER_PROVIDER` (`groq` is a good hosted default; `claude-code` needs a CLI the image does not have).
- Keep it private if your host allows it (internal networking). It authenticates every call with `SUPERVISOR_AGENT_TOKEN` either way.

### 2. Backend

- Build with `backend/Dockerfile`, or run `npm ci && npm start` from `backend/`.
- Must support **WebSockets** (Socket.io carries pipeline progress).
- Required in production: `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, `BYOK_ENCRYPTION_KEY` (the server refuses to start without them), `MONGODB_URI`.
- `SUPERVISOR_AGENT_URL` = the engine's URL, `SUPERVISOR_AGENT_TOKEN` = the same token.
- `FRONTEND_URL` = your site's public URL. Add preview deploy origins to `CORS_ORIGINS`.
- `TRUST_PROXY` = the number of proxies in front (defaults to 1 in production). Wrong values make every user share one rate-limit bucket.
- Generated boards: if the engine has its own disk, nothing else is needed — the backend proxies `/uploads/boards/*` to the engine. User uploads still need a persistent disk at `UPLOAD_DIR`.

### 3. Frontend

- On Vercel, set the project root to `frontend/`. Elsewhere, use `frontend/Dockerfile`.
- `BACKEND_URL` — the backend's URL, used by the `/api` and `/uploads` rewrites. **Read at build time**: set it in the build environment.
- `NEXT_PUBLIC_BACKEND_URL` — the backend's public URL, for the browser's Socket.io connection.
- `NEXT_PUBLIC_SITE_URL` — your public URL.

### 4. Google sign-in (optional)

Point `GOOGLE_REDIRECT_URI` at the **frontend's** origin — `https://app.example.com/api/v1/auth/google/callback` — so the rewrite carries the callback to the backend and the auth cookies are set on the site's own domain. Register the same URL in Google Cloud Console.

## How auth works across two domains

API calls go through the frontend's `/api` rewrite, so auth cookies are first-party on the frontend's domain. The Socket.io connection goes straight to the backend, a different origin, where those cookies are not sent. So the browser fetches a two-minute, socket-only token from `GET /api/v1/auth/socket-token` and presents it in the handshake. The token is refused as an API credential.

## Billing and BYOK

- `BILLING_ENABLED=false` (default): no quotas. Use this for local and self-hosted installs.
- `BILLING_ENABLED=true`: the plan limits in `backend/src/config/plans.js` apply to work that runs on **your** keys. A user's own key (Settings → API keys) is never counted.
- Upgrades: set `BILLING_CHECKOUT_URL_PRO` to a checkout link (e.g. a Stripe Payment Link). Once paid, an admin applies the plan:

  ```bash
  curl -X PATCH https://api.example.com/api/v1/billing/users/<userId>/plan \
    -H "Authorization: Bearer <admin access token>" \
    -H "content-type: application/json" -d '{"plan":"pro"}'
  ```

  A payment webhook would make the same update; it is the next step when payments are automated.

## Health checks

- Backend: `GET /health`
- AI engine: `GET /health`
- What the engine can run (needs the token): `GET /api/v1/supervisor/capabilities`

## Limits of a single instance

The backend keeps in-flight job status in memory (`supervisor.service.js`), and Socket.io rooms are per process. Run **one** backend instance, or add Redis (the Socket.io Redis adapter, and a Redis-backed job store) before scaling out.
