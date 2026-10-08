# Dunk AI

Dunk AI is an AI-powered hardware copilot that turns a natural-language hardware idea into a structured engineering design package.

The Next.js website, Node API and MongoDB Atlas stay hosted. The original
Python supervisor, LangGraph agents, catalogue selection and dunkai-designer
run on each user's computer in the **DunkAI local runtime**. This replaces the
browser pipeline and retains the existing requirements interview, BOM pricing,
PCB handoff and board generator.

Enable `LOCAL_RUNTIME_ENABLED=true` on the backend. Users install Docker, start
the downloaded runtime and pair it in Settings. Groq inference remains remote:
the operator key stays on the backend, or a user's BYOK key stays on their
computer. No local generative model, hosted Python engine, Redis worker or
tunnel is needed. See [local setup and deployment](docs/LOCAL_RUNTIME.md).

## Architecture

```text
Website → hosted Node API + Atlas job queue
                         ↑ outgoing authenticated HTTPS
                user's local runtime
                Python agents → catalogue → PCB designer
                         ↓
          hosted Groq gateway or direct local BYOK → Groq
```

The runtime sends original supervisor progress/results back to the API, which
uses the existing Socket.io workspace protocol. Board files are stored privately
in Atlas GridFS. Generated hardware is unverified; fabrication exports remain
blocked pending independent checks.

The original dedicated-engine deployment remains available with
`LOCAL_RUNTIME_ENABLED=false`. `docker-compose.yml` is the optional development
stack; `render.yaml` only provisions the Node backend for local execution.

## Repository structure

```text
.
├── ai_engine/             # Python AI agents and AI orchestration
├── backend/               # Dunk AI Node.js/Express API
│   ├── src/config/        # Environment and database configuration
│   ├── src/controllers/   # HTTP request handlers
│   ├── src/middleware/    # Auth, validation, uploads, and errors
│   ├── src/models/        # Mongoose data models
│   ├── src/repositories/  # Persistence abstraction
│   ├── src/routes/        # Versioned API routes
│   ├── src/services/      # Business logic and Supervisor client
│   ├── src/sockets/       # WebSocket handlers for real-time AI streaming
│   └── src/server.js      # Application entry point
├── docs/                  # Project documentation and diagrams
└── frontend/              # Next.js React Web Workspace
    ├── app/               # Next.js App Router (Auth, Dashboard, Workspace)
    ├── components/        # React components (Chat Interface, View Tabs, UI)
    ├── hooks/             # Custom React hooks (Store, API)
    └── lib/               # API clients and utilities
```

## Features & Recent Updates

- **Real-time Pipeline UI:** The Next.js frontend features a live, tabbed workspace (Chat, PCB, Requirements, Architecture, BOM, Validation, EDA, Docs). AI outputs stream directly into these tabs over WebSockets.
- **Multi-turn Context Retention:** The AI engine now maintains full conversation history across multiple turns without losing context. Fixed React state closure bugs to ensure accurate requirement tracking.
- **Dynamic BOM & Cost Mappings:** The Component Agent extracts and maps real-world `mfr_part` numbers, costs, and availability directly into the UI.
- **Responsive Layouts:** Flexbox-optimized view containers (`min-h-0`) ensure smooth scrolling and responsive rendering of long component tables and validation reports.
- **Architecture Visualization:** Real-time graph parsing and ReactFlow layouts for dynamic hardware topology diagrams.

## Backend capabilities

- JWT authentication, refresh sessions, roles, and user identity
- Project creation, editing, sharing, archiving, duplication, and ownership
- Project chat sessions and persisted conversation history
- Multipart file uploads for project assets and datasheets
- Supervisor-only workflow execution and chat orchestration
- MongoDB persistence with Mongoose models for users, projects, chats, messages, files, sessions, and artifacts
- Standard API responses, request validation, rate limiting, security headers, CORS, logging, and global error handling
- Swagger UI at `/docs` and a health endpoint at `/health`

## Getting started

Each service has an `.env.example`; copy it and fill it in. Never commit the copies.

### AI engine (optional dedicated development mode)

```bash
cd ai_engine
python3 -m venv venv && source venv/bin/activate
pip install -r requirement.txt
cp .env.example .env          # GROQ_API_KEY, HF_TOKEN_READ
python -m agents.supervisor.server
```

Board generation also needs `cd dunkai-designer && npm install`.

### Backend

```bash
cd backend
cp .env.example .env          # MONGODB_URI, JWT_* secrets
npm install
npm run check
npm run dev                   # http://localhost:4000, API docs at /docs
```

### Frontend

```bash
cd frontend
cp .env.example .env.local
npm install
npm run dev                   # http://localhost:3000
```

### Everything at once

```bash
docker compose up --build
```

See [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) for the compose setup and for hosting on Vercel, Render, Railway or Fly.io.

## Bring your own keys (BYOK)

In local mode, set `DUNKAI_GROQ_API_KEY` in `runtime/runtime.env` on the user's
computer. It is never uploaded to DunkAI. Leave it blank for protected hosted
Groq inference. Previously stored cloud keys remain encrypted for the optional
legacy dedicated-engine deployment.

## Plans

Local computation, including PCB generation, uses zero DunkAI credits. Verified
accounts get five hosted **model completions** per UTC month, then pay two
credits per successful completion. A full project can use multiple calls.
BYOK uses zero DunkAI credits, with provider usage billed by the user's Groq
account. Local mode grants no new 150-credit trial; existing balances remain.

Prepaid packs remain 200 credits/₹200, 500/₹500, and 1,500/₹1,500. Setting
`BILLING_ENABLED=false` closes purchases but still enforces the hosted quota.
For local testing only, `DISABLE_CREDITS_FOR_TESTING=true` bypasses the quota.
Production ignores this bypass. See [the runbook](docs/LAUNCH_RUNBOOK.md).

## Main API groups

| Group | Purpose |
| --- | --- |
| `/api/v1/auth` | Registration, login, refresh, logout, and current user |
| `/api/v1/projects` | Project lifecycle and collaboration |
| `/api/v1/chats` | Chat sessions and messages |
| `/api/v1/files` | Project file uploads and listings |
| `/api/v1/ai` | WebSocket streaming and Supervisor integration |
| `/api/v1/account` | BYOK key management |
| `/api/v1/billing` | Credit packs, wallet, quote, checkout, and signed Stripe webhook |

## Engineering principles

- Keep controllers thin and place business logic in services.
- Keep database access behind repositories/models.
- Keep AI communication behind the Supervisor client.
- Validate all client input and use environment variables for secrets.
- Build modules incrementally and verify them with `npm run check`.

## Project status

The backend foundation, Next.js frontend workspace, and core AI integrations are implemented and functional. The platform supports complete end-to-end hardware generation pipelines, from natural language prompt to BOM and Architecture outputs.
