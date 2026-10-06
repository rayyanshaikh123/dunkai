# Dunk AI

Dunk AI is an AI-powered hardware copilot that turns a natural-language hardware idea into a structured engineering design package.

The browser deployment combines a Next.js workspace, a Node.js API and MongoDB Atlas. Users describe hardware projects and receive requirements, architecture, component data, PCB previews, firmware source and documentation. Heavy design computation runs on the visitor's device in Web Workers; model inference runs remotely on Groq through the authenticated Node API.

**Every user's desktop browser** follows the same path after a simple confirmation. Enable `BROWSER_COMPUTE_ONLY=true` on the API and build the frontend with `NEXT_PUBLIC_BROWSER_COMPUTE_ONLY=true`. No installed companion, local LLM, Python engine, Redis worker or tunnel is needed. Use [the deployment runbook](docs/LAUNCH_RUNBOOK.md) with your existing frontend, Node host and Atlas.

The runtime supports passives, NE555P and general exact catalogue-backed components with verified structural pin/pad correspondence, including schema 2.0 nets. Missing geometry or unresolved mappings become review findings. Firmware supports local Uno/Nano AVR C/C++ compilation with Wire/SPI and MicroPython source delivery for ESP32/RP2040. [Support bounds and test evidence](docs/BROWSER_COMPUTE_PLAN.md) distinguish implemented behavior from electrical/fabrication approval and live deployment acceptance.

Verified accounts receive five hosted model requests per UTC month; each additional request costs two credits. Applicable firmware uses a second request. Local compute and Groq BYOK use zero DunkAI credits. Free quota enforcement works while Stripe purchases are disabled. `render.yaml` now provisions only the free Node API; the paid legacy blueprint is `render.cloud.yaml`. Fabrication files remain blocked pending independent checks and human approval.

## Architecture

The legacy cloud-engine architecture diagram is preserved for reference:

![Legacy Dunk AI system architecture](docs/dunk-ai-architecture.png)

The supplied architecture diagram is preserved in [`docs/dunk-ai-architecture.png`](docs/dunk-ai-architecture.png).

### Request flow

1. A user submits a hardware idea through the web frontend.
2. The website asks for local computation confirmation and checkpoints the request.
3. A browser worker orchestrates design stages; the Node API authenticates and meters bounded Groq inference using the operator key or encrypted BYOK.
4. Browser workers resolve component pins/footprints, map nets, place/route the board and prepare previews.
5. Applicable firmware is generated, edited and compiled locally for supported targets.
6. Private project artifacts are saved through the Node API to Atlas. Interrupted runs reuse saved stage answers.
7. The user downloads a review ZIP, previews and source/HEX files. Engineering review is required before hardware fabrication or operation.

## Legacy cloud service boundary

With browser mode disabled, the original Node/Python path remains available: Node calls the Supervisor rather than individual Python agents. Deploy it using `render.cloud.yaml` and [the legacy runbook](docs/CLOUD_ENGINE_RUNBOOK.md). The browser deployment rejects Python workflow and server compiler routes.

The `ai_engine/` directory is an independent Python/LangGraph/LangChain system. The Node.js backend communicates with it through the configured Supervisor HTTP endpoint. This separation keeps API concerns and AI orchestration concerns independent.

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

### AI engine

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

Users can add their own **Groq**, **Gemini** and **Anthropic** keys in Settings → API keys. Groq powers every pipeline agent, and all three can build boards.

- A key is verified with the provider when saved, encrypted with AES-256-GCM (`BYOK_ENCRYPTION_KEY`), and never returned to the browser except as `gsk_…a1b2`.
- In the legacy cloud path, the backend passes the decrypted key to the supervisor per request. In experimental browser mode, the Node backend uses the key only for the authenticated Groq relay; the browser never receives it.
- A user's key pays its provider tokens. When credits are enabled, pipeline compute is 10 credits and board compute/export is 20 credits.

## Plans

Freemium with prepaid INR credits is configured in `backend/src/config/credits.js`. A verified account receives 150 one-time trial credits and five hosted AI chat turns per UTC month. Packs are 200 credits/₹200, 500/₹500, and 1,500/₹1,500. Chat, pipeline, and Groq board runs quote 2, 30, and 101 credits respectively; BYOK pipeline and board compute quote 10 and 20. Credits are enforced only when `BILLING_ENABLED=true`. See the [launch runbook](docs/LAUNCH_RUNBOOK.md) before turning that switch on.

Browser mode gives verified accounts five hosted model requests per UTC month with **no new 150-credit trial grant**. A hosted inference request costs 2 credits after free requests; BYOK and local work use no DunkAI credits. A non-MCU project typically uses one request (2 credits), and a supported MCU project with firmware uses two (4 credits). Existing wallet balances are retained when switching modes. These quotas are enforced even with Stripe disabled.

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
