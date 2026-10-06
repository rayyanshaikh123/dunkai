# DunkAI Local Runtime — Superseded Plan

This document describes the earlier installable-companion approach. The user has since specified a website-only experience: a confirmation in the page starts computation in the browser, with no installer or separate runtime. The current plan is [docs/BROWSER_COMPUTE_PLAN.md](docs/BROWSER_COMPUTE_PLAN.md). Do not implement the companion, CLI, or device-auth phases below for the browser-first product.

## 1. Goal

Move DunkAI's **orchestration and hardware-design computation to the user's machine** while keeping the SaaS cloud lightweight.

The local runtime will execute the agent graph, PCB generation, BOM generation, firmware generation, validation, and local artifact management.

LLM inference will support two modes:

1. **DunkAI Hosted** — the local runtime sends LLM requests through the DunkAI API. DunkAI authenticates the user, enforces credits/rate limits, calls Groq with DunkAI's server-side key, records usage, and streams the response back.
2. **BYOK** — the local runtime calls Groq directly using the user's own API key. The key remains on the user's machine and is never uploaded to DunkAI.

The main objective is to remove the need to host the expensive AI orchestration/PCB engine for every user while preserving authentication, billing, usage control, and the web product.

---

## 2. Target Architecture

```text
                           DUNKAI CLOUD

      ┌──────────────────────────────────────────────┐
      │                                              │
      │  Vercel                                      │
      │  └── Next.js frontend                        │
      │             │                                │
      │             ▼                                │
      │  Render / Node API                           │
      │  ├── Authentication                          │
      │  ├── Projects / metadata                     │
      │  ├── Credits / entitlements                  │
      │  ├── Stripe                                  │
      │  ├── Device authorization                    │
      │  └── Hosted LLM gateway ─────────► Groq      │
      │             │                                │
      │             ▼                                │
      │       MongoDB Atlas                          │
      │                                              │
      └─────────────────────┬────────────────────────┘
                            │ HTTPS / streaming
                            │
                            ▼
                    USER'S COMPUTER

      ┌──────────────────────────────────────────────┐
      │           DunkAI Local Runtime               │
      │                                              │
      │  Local Orchestrator / LangGraph              │
      │  ├── Architecture agent                      │
      │  ├── Component-selection agent               │
      │  ├── BOM agent                               │
      │  ├── PCB agent                               │
      │  ├── Firmware agent                          │
      │  └── Validation                              │
      │                                              │
      │  dunkai-designer / tscircuit                 │
      │  Local filesystem / generated artifacts      │
      │                                              │
      └─────────────────────┬────────────────────────┘
                            │
                  ┌─────────┴──────────┐
                  │                    │
          DUNKAI HOSTED              BYOK
                  │                    │
           DunkAI API             Direct Groq
                  │              using user's key
                  ▼                    │
                Groq ◄─────────────────┘
```

---

## 3. Core Design Rules

### 3.1 Orchestration is local

The following workloads should execute on the user's computer:

- LangGraph/orchestration
- Agent sequencing
- Architecture generation workflow
- Component selection logic
- BOM construction
- PCB generation
- `dunkai-designer`
- tscircuit execution
- Firmware generation workflow
- DRC/ERC and other local validation where supported
- Artifact/file generation
- Project workspace operations

### 3.2 Secrets owned by DunkAI stay in the cloud

Never ship the DunkAI Groq API key inside the CLI, desktop application, frontend bundle, configuration files, or local runtime.

Hosted inference must follow:

```text
Local Runtime
     ↓
DunkAI LLM Gateway
     ↓
Authentication + credit check
     ↓
DunkAI Groq key
     ↓
Groq
     ↓
Streaming response
     ↓
Local Runtime
```

### 3.3 BYOK keys stay local

BYOK should follow:

```text
Local Runtime ─────► Groq
                  user's key
```

Prefer OS credential storage:

- macOS Keychain
- Windows Credential Manager
- Linux Secret Service/keyring

Do not upload BYOK keys to MongoDB for the local execution mode.

### 3.4 Billing remains server-authoritative

Never trust a modified local client to determine credits, balances, purchases, or hosted inference entitlement.

The server remains authoritative for:

- user identity
- subscription/plan
- credit balance
- Stripe purchases
- hosted LLM authorization
- hosted LLM usage records
- rate limits

### 3.5 Cross-platform release contract

The local runtime must support **Windows, macOS, and Linux** in the first public release. A successful run on one developer machine does not satisfy this requirement. The same project format, provider selection, job events, PCB validation rules, and billing behavior must work on all three operating systems.

The **website is the primary product interface** on every OS. Users start, monitor, inspect, and manage projects in the browser; an installed local companion performs computation on that computer. The CLI is a development and diagnostic interface, not the required public workflow. If the companion is absent, disconnected, or unsupported, the website must explain the issue and prevent starting a local compute job.

Define and publish the supported OS versions, CPU architectures, and Linux distribution baseline after auditing the Python, Node, tscircuit, and sandbox dependencies. Build and test native packages for each supported target. Development may proceed incrementally, but do not label the local runtime public-ready or retire cloud execution until every supported OS passes the same end-to-end checks.

Generated board code must execute in an isolation mechanism that is tested on the host OS. Keep sandbox enforcement on by default and fail closed if the mechanism is unavailable. The launcher must handle OS-specific paths, subprocesses, signals, credential storage, permissions, and artifact opening without changing the project protocol.

---

# 4. Migration Strategy

Do **not** rewrite DunkAI from scratch.

Migrate the existing system incrementally.

Current flow:

```text
Frontend
   ↓
Node API
   ↓
Redis / BullMQ
   ↓
AI Worker
   ↓
Python Supervisor
   ↓
Agents + dunkai-designer
```

Target local flow:

```text
Frontend / CLI
      ↓
DunkAI Local Runtime
      ↓
Python Supervisor
      ↓
Agents + dunkai-designer
```

LLM calls branch into:

```text
Hosted → DunkAI API → Groq
BYOK   → Groq directly
```

The existing cloud worker/engine can remain temporarily while local mode is developed.

---

# 5. Phase 0 — Freeze and Map Existing Interfaces

## Objective

Document the current boundaries before changing code.

## Tasks

Identify every call between:

- frontend → Node backend
- Node backend → BullMQ
- worker → `callSupervisorStream()`
- worker → Python supervisor
- supervisor → Groq/provider
- supervisor → `dunkai-designer`
- supervisor → `/data/boards`

Create a common job schema based on the existing worker payload.

Example:

```ts
interface DunkAIJob {
  jobId: string;
  action: string;
  project: unknown;
  messages?: unknown[];
  files?: unknown[];
  agentType?: string;
  provider?: string;
  model?: string;
  chatId?: string;
}
```

Document all stream events currently emitted by `callSupervisorStream()`.

Examples may include:

```text
job.started
agent.started
agent.message
agent.completed
tool.started
tool.completed
artifact.created
job.completed
job.error
```

Use the real event names from the repository rather than inventing replacements.

## Exit criteria

A developer can describe exactly how one current pipeline request travels from the frontend to the final generated artifact.

---

# 6. Phase 1 — Extract a Provider Interface

## Objective

Make agents independent of where LLM inference is performed.

Introduce a provider abstraction in the Python/local orchestration layer.

Conceptually:

```python
class LLMProvider:
    async def stream(self, request):
        ...
```

Implement:

```text
GroqBYOKProvider
DunkAIHostedProvider
```

### BYOK provider

```text
Agent
 ↓
GroqBYOKProvider
 ↓
Groq API
```

Uses a local user credential.

### Hosted provider

```text
Agent
 ↓
DunkAIHostedProvider
 ↓
DunkAI API
 ↓
Groq
```

The orchestration code should not care which route is selected.

## Exit criteria

The same agent pipeline can run using either provider without changing agent logic.

---

# 7. Phase 2 — Build the DunkAI Hosted LLM Gateway

## Objective

Allow local orchestration to use LLM capacity paid for by DunkAI without exposing DunkAI's provider credentials.

Suggested API surface:

```text
POST /api/v1/inference/stream
```

Request concept:

```json
{
  "model": "selected-model",
  "messages": [],
  "jobId": "...",
  "agent": "pcb"
}
```

Server flow:

```text
Authenticate
   ↓
Validate request
   ↓
Check billing/entitlement
   ↓
Reserve or authorize usage
   ↓
Call Groq using server key
   ↓
Stream response to client
   ↓
Capture provider usage
   ↓
Settle credits
   ↓
Persist usage record
```

### Requirements

- Never return the provider API key.
- Validate model names server-side.
- Set request/token limits.
- Rate-limit users and devices.
- Record actual provider token usage when available.
- Associate usage with user + job + agent.
- Handle interrupted streams.
- Make settlement idempotent.
- Do not let a client specify arbitrary monetary cost.

## Exit criteria

A local test script can authenticate to DunkAI, request hosted inference, receive a streamed response, and produce a correctly recorded server-side usage entry without receiving the Groq key.

---

# 8. Phase 3 — Create the Local Runtime

## Objective

Run the existing supervisor and design pipeline without the Render worker.

Initial development layout:

```text
dunkai-runtime/
├── cli/
├── runtime/
├── auth/
├── providers/
├── storage/
├── protocol/
└── installer/

ai_engine/

dunkai-designer/
```

The first engineering version can use a CLI to prove the runtime. The public version must be an installable background companion controlled from the website; users should not need to run commands to generate a board.

Start with a CLI such as:

```bash
dunkai login
dunkai init
dunkai doctor
dunkai run
dunkai logout
```

Example:

```bash
dunkai run "Design an ESP32 environmental monitoring board"
```

The local runtime should:

1. Load project context.
2. Verify the local installation.
3. Resolve provider mode.
4. Start the supervisor.
5. Execute the orchestration graph.
6. Stream progress locally.
7. Generate artifacts in the project directory.
8. Return a structured completion result.

## Exit criteria

A complete DunkAI pipeline runs on clean Windows, macOS, and Linux test machines without Redis, BullMQ, or the cloud AI worker. Each machine generates the same required artifact types and reports the same job events. A failure on any supported OS blocks public release.

---

# 9. Phase 4 — Local Authentication / Device Authorization

## Objective

Allow the local runtime to authenticate securely without asking users to paste web session tokens.

Preferred UX:

```bash
dunkai login
```

Then:

```text
Opening browser...

DunkAI wants to authorize this device.

[Authorize]
```

After authorization, the CLI receives a device/session credential.

Store the credential in secure OS storage.

### Security requirements

- Short-lived access tokens.
- Rotatable/revocable device credentials.
- Device sessions visible/revocable from account settings eventually.
- Do not reuse browser cookies as permanent CLI credentials.
- Do not put tokens in project files.

## Exit criteria

A user can log in from the CLI, close it, reopen it, remain securely authenticated, and revoke the device from the server.

---

# 10. Phase 5 — BYOK Local Credential Management

## Objective

Allow users to configure their own provider key without sending it to DunkAI.

Example UX:

```bash
dunkai provider set groq
```

Prompt securely for the key rather than placing it directly in shell history.

Commands could include:

```bash
dunkai provider status
dunkai provider test groq
dunkai provider remove groq
```

Project configuration stores only provider selection:

```json
{
  "providerMode": "byok",
  "provider": "groq"
}
```

The secret itself lives in OS credential storage.

## Exit criteria

A user can run the full pipeline through their own Groq account while network inspection confirms that their provider key is never sent to DunkAI servers.

---

# 11. Phase 6 — Local Project Workspace

## Objective

Make generated hardware projects first-class local directories.

Suggested structure:

```text
my-dunkai-project/
├── dunkai.json
├── architecture/
│   └── architecture.json
├── components/
├── schematic/
├── pcb/
│   └── board.tsx
├── firmware/
├── bom/
│   └── bom.csv
├── output/
└── .dunkai/
    ├── state.json
    └── logs/
```

Do not put API keys or durable authentication secrets in `.dunkai/`.

Use atomic writes for important generated files.

## Exit criteria

Projects survive application restarts and can be opened, regenerated, version-controlled, and moved between directories without depending on Render disks.

---

# 12. Phase 7 — Connect the Web App to the Local Runtime

## Objective

Make the DunkAI website the primary interface while execution occurs on the user's Windows, macOS, or Linux computer.

Do not begin with this phase. First make the CLI/runtime reliable.

Possible architecture:

```text
DunkAI Web App
      │
      │ cloud session / job coordination
      ▼
DunkAI API
      ▲
      │ authenticated outbound connection
      │
DunkAI Local Runtime
```

Prefer the local runtime initiating an outbound authenticated connection for job control rather than exposing an unauthenticated local network server. A local artifact bridge may be needed for large PCB previews; compare an origin-restricted, authenticated loopback bridge against a cloud relay on the supported browsers before choosing. Do not rely on a permanent cloud upload or paid object storage for every local artifact. Keep full project files on the user's computer unless the user explicitly shares them.

The web UI should be able to show:

```text
Local Runtime: Connected
Device: Rayyan's Mac
Runtime: Ready
Provider: DunkAI Hosted / BYOK
```

Then a web-created job can be claimed by the authorized local runtime. The website must show progress, errors, generated files, and PCB previews, including after a browser refresh or companion restart.

### Important

Do not expose a localhost command endpoint that arbitrary websites can invoke. Protect against cross-origin requests, CSRF-like local attacks, unauthorized websocket connections, and malicious project payloads.

## Exit criteria

A job initiated from the DunkAI website executes on the authorized user's Windows, macOS, or Linux machine. Progress and authorized local PCB previews appear in the browser, and reconnecting does not lose the job or its files. Validate the supported browser and OS combinations.

---

# 13. Phase 8 — Replace BullMQ for Local Jobs

## Objective

Remove cloud queue infrastructure from the default local execution path.

Current:

```text
API → Redis → Worker → Supervisor
```

New:

```text
API ↔ Local Runtime → Supervisor
```

Keep BullMQ temporarily for legacy/cloud jobs until local execution is stable.

Add an execution target field:

```text
local
cloud
```

Conceptually:

```json
{
  "executionTarget": "local"
}
```

Only remove Redis/worker infrastructure after no required production feature depends on it.

## Exit criteria

All normal local jobs work with Redis and the AI worker disabled.

---

# 14. Phase 9 — Packaging

## Objective

Users should not need to manually install Python, Node, PyTorch, tscircuit, or repository dependencies.

Development can initially use the repository environment.

Production target:

```text
Windows → DunkAI Setup.exe
macOS   → DunkAI.dmg / signed application
Linux   → package/AppImage or supported installer
```

Produce separate builds for every supported OS/CPU target. Run installation, upgrade, `dunkai doctor`, BYOK and hosted-provider tests, a known-good PCB fixture, and an intentionally unsafe PCB fixture on native CI runners or clean virtual machines. Verify file paths, subprocess cancellation, local credential storage, and artifact persistence on each target.

Possible later CLI experience:

```bash
dunkai doctor
```

Output:

```text
✓ DunkAI runtime
✓ Authentication
✓ Designer
✓ Local workspace
✓ Groq provider
✓ Sandbox support

Ready.
```

### Important

Your existing Docker image includes Python, Node, PyTorch CPU, bubblewrap, and `dunkai-designer`. Treat packaging as a separate engineering problem rather than simply requiring every customer to install Docker.

## Exit criteria

Clean Windows, macOS, and Linux test machines can install DunkAI and successfully execute the same sample project without developer tooling.

---

# 15. Phase 10 — Local Sandbox and Security

Moving execution to the user's computer makes sandboxing **more important**, not less important.

Generated code must not automatically receive unrestricted access to:

- home directory
- SSH keys
- browser profiles
- cloud credentials
- environment variables
- arbitrary network destinations
- unrelated project directories

Retain the principle behind:

```text
BOARD_SANDBOX_REQUIRED=true
```

Develop OS-specific isolation where necessary. Bubblewrap is Linux-specific, so macOS and Windows require their own execution strategy. Select and prove each strategy before enabling local board generation on that OS. Never silently fall back to unsandboxed generated-code execution.

Treat generated code as untrusted.

## Exit criteria

Known malicious fixtures cannot read protected credentials, escape the allowed workspace, or make prohibited network calls on Windows, macOS, or Linux.

---

# 16. Phase 11 — Redesign Credits

Do not base the new model primarily on local CPU work because DunkAI no longer pays for that computation.

Separate:

### Hosted inference

```text
Local orchestration
Local PCB compute
DunkAI-paid LLM inference → credits
```

### BYOK

```text
Local orchestration
Local PCB compute
User-paid LLM inference
```

The existing fixed credit system can remain during migration, but collect real usage before finalizing new pricing.

For hosted inference record:

```text
user
job
agent
provider
model
input tokens
output tokens
provider request ID if available
credits reserved
credits settled
timestamp
```

Compare real Groq invoices against internal usage before enabling unrestricted paid billing.

---

# 17. Phase 12 — Optional Cloud Execution

Cloud execution can return later as a paid convenience feature.

Final product can support:

```text
                 DunkAI
                    │
          ┌─────────┴─────────┐
          │                   │
       LOCAL               CLOUD
          │                   │
 User computer          DunkAI compute
          │                   │
 BYOK or hosted         Hosted inference
          │                   │
 Lower cost             Convenience
```

This makes cloud compute an upgrade rather than a requirement for launching the product.

---

# 18. Components From the Existing System

## Keep

- Vercel frontend
- Node API
- MongoDB Atlas
- authentication
- Google OAuth
- email verification
- Stripe
- wallet/credit ledger
- project metadata
- Groq integration
- Python supervisor logic
- LangGraph/agents
- `dunkai-designer`
- tscircuit
- existing board validation work

## Refactor

- provider calls behind a provider interface
- supervisor so it can run as a local process
- streaming protocol
- job lifecycle
- artifact paths
- credentials handling

## Eventually optional/remove for local mode

- Redis
- BullMQ AI worker
- private Render AI engine
- Render engine disk
- API upload disk for locally owned artifacts

Do not delete these until the local replacement passes acceptance tests.

---

# 19. Suggested Repository Direction

One possible end state:

```text
dunkai/
├── frontend/                 # Next.js web application
├── backend/                  # Cloud control plane/API
│   ├── auth/
│   ├── billing/
│   ├── inference/
│   ├── projects/
│   └── devices/
│
├── runtime/                  # Local DunkAI application
│   ├── cli/
│   ├── auth/
│   ├── protocol/
│   ├── providers/
│   ├── workspace/
│   └── launcher/
│
├── ai_engine/                # Python orchestration
│   ├── agents/
│   ├── providers/
│   └── supervisor/
│
├── dunkai-designer/
└── packages/
    └── protocol/             # shared schemas if useful
```

Avoid a large repository restructure at the beginning. Move files only when the interface is stable.

---

# 20. Implementation Order

Follow this order to reduce risk:

```text
1. Map current worker/supervisor protocol
                ↓
2. Extract LLM provider interface
                ↓
3. Implement direct local BYOK provider
                ↓
4. Prove sandboxed board execution on Windows/macOS/Linux
                ↓
5. Run complete pipeline locally on all three OSes
                ↓
6. Build hosted LLM gateway
                ↓
7. Add CLI authentication/device auth
                ↓
8. Add secure local credential storage
                ↓
9. Stabilize local workspace/artifacts
                ↓
10. Add web ↔ local job coordination
                ↓
11. Remove Redis/BullMQ from local path
                ↓
12. Package and test Windows/macOS/Linux runtime
                ↓
13. Complete cross-platform security and sandbox testing
                ↓
14. Rework pricing using measured usage
                ↓
15. Retire unnecessary cloud compute
```

---

# 21. First Development Milestone

Do not attempt the complete architecture immediately.

The first milestone should prove one thing:

> **Can the existing DunkAI pipeline run completely on Windows, macOS, and Linux, with orchestration and sandboxed PCB generation local, while LLM inference is provided through a selectable provider interface?**

Build this first:

```text
Terminal
   │
   ▼
Local DunkAI launcher
   │
   ▼
Existing Python Supervisor
   │
   ├── local orchestration
   ├── agents
   ├── dunkai-designer
   └── local artifacts
   │
   ▼
BYOK Groq
```

No web-to-local integration is needed for this **internal engineering milestone**. A single-OS prototype is useful for development but does not complete the milestone. The website and local companion integration is required before any public beta.

Once this works, implement:

```text
BYOK Groq
    ↓ replace provider only
DunkAI Hosted Gateway
```

If both work against the same orchestration code, the most important architectural separation has succeeded.

---

# 22. Acceptance Checklist

Before making local execution the default:

- [ ] Windows, macOS, and Linux each pass the same end-to-end pipeline and PCB fixture checks.
- [ ] Installer, upgrade, cancellation, credentials, and artifact persistence work on each supported OS.
- [ ] The website starts and monitors local jobs and displays PCB previews on each supported OS and browser.
- [ ] The website handles companion disconnects, browser refreshes, and local artifact access without losing completed work.
- [ ] Generated board code fails closed when OS-specific isolation is unavailable.
- [ ] Full architecture → BOM → PCB → firmware pipeline runs locally.
- [ ] Local pipeline works without Redis.
- [ ] Local pipeline works without BullMQ worker.
- [ ] Local pipeline works without Render AI engine.
- [ ] BYOK Groq key never reaches DunkAI servers.
- [ ] DunkAI Groq key never reaches the user's machine.
- [ ] Hosted inference usage is measured server-side.
- [ ] Credit settlement is idempotent.
- [ ] Interrupted streams do not double-charge.
- [ ] Device authentication can be revoked.
- [ ] Local secrets are stored outside project files.
- [ ] Generated code is sandboxed.
- [ ] PCB validation fixtures pass on supported operating systems.
- [ ] Cross-user project/job access is denied.
- [ ] Local artifacts survive restart.
- [ ] Installer works on clean machines.
- [ ] Web UI clearly indicates whether the runtime is connected.
- [ ] Hosted/BYOK mode is clearly visible to the user.
- [ ] Existing cloud execution remains available until migration is proven.

---

# 23. What Not to Do

Do not:

- expose the DunkAI Groq key to the local runtime;
- trust local clients for balances or payment state;
- put BYOK secrets in `dunkai.json`;
- remove the current worker/engine before the local pipeline is proven;
- require Docker as the final consumer UX unless DunkAI explicitly targets developers comfortable with Docker;
- expose an unsecured localhost API to browsers;
- assume Linux Bubblewrap provides equivalent isolation on Windows/macOS;
- enable fabrication export solely because generation completed successfully;
- redesign every service at once.

---

# 24. Recommended MVP

For the first public local-runtime beta, support:

**Windows, macOS, and Linux are all required.** Each supported OS must offer the same local orchestration, PCB/BOM/firmware generation, BYOK and hosted Groq modes, and security checks.

```text
DunkAI Web
  ├── Account
  ├── Billing
  ├── Projects
  ├── Start/monitor local runs and inspect PCB previews
  └── Install/connect DunkAI Runtime

DunkAI Runtime (installed background companion)
  ├── Login
  ├── Project workspace
  ├── Local orchestration
  ├── Local PCB/BOM/firmware generation
  ├── BYOK Groq
  └── DunkAI Hosted Groq

DunkAI Cloud
  ├── Auth
  ├── MongoDB
  ├── Stripe
  ├── Credits
  ├── Device auth
  └── Hosted Groq gateway
```

Leave optional fully hosted orchestration for a later paid tier.

---

# 25. Immediate Next Engineering Task

Before changing deployment, modify the codebase so that **LLM access is an injectable dependency of the supervisor/orchestrator**.

The desired boundary is:

```text
                 ORCHESTRATOR
                      │
                      ▼
              LLM Provider Interface
                 /             \
                /               \
               ▼                 ▼
       DunkAIHostedProvider   GroqBYOKProvider
               │                 │
               ▼                 ▼
          DunkAI API            Groq
               │
               ▼
              Groq
```

Once that boundary exists, moving orchestration from Render to the user's computer becomes substantially easier because the agent graph no longer depends on where inference credentials or inference execution are hosted.
