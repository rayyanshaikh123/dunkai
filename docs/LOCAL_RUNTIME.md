# DunkAI local runtime

The website and Node API stay hosted. Each user runs the existing Python
supervisor, LangGraph agents, component catalogue and dunkai-designer on their
own computer inside Docker. The browser displays progress and results. There
is no hosted Python engine, Redis worker, tunnel or incoming localhost port.

## User setup — Windows, macOS, Linux

1. Install and start Docker Desktop, or Docker Engine on Linux. Windows must
   use Linux containers. Allow approximately 4 GB memory and several GB disk
   for the image, component dataset and embedding cache. Keep at least 8 GB
   free during the initial Docker build to allow for installation and export.
2. Sign in and verify your email. In **Settings → This computer**, download
   and extract the runtime bundle.
3. Copy `runtime/runtime.env.example` to `runtime/runtime.env`. Set
   `DUNKAI_BACKEND_URL` to the hosted **Node API** URL. For your own Groq key,
   set `DUNKAI_GROQ_API_KEY`; otherwise leave it empty. Keep this file private.
4. Run `runtime/start.bat` on Windows, `runtime/start.command` on macOS, or
   `sh runtime/start.sh` on Linux. The first start builds the container and
   downloads the engine's dependencies. On macOS, if Finder blocks the command
   file, run `sh runtime/start.sh` in Terminal from the extracted folder.
5. Enter the displayed pairing code in Settings. The catalogue loads on first
   use. Wait until your computer shows **Ready**, then create a design. The
   component stage may take longer on its first run while the catalogue loads.
6. Keep Docker and the runtime window open while generating. Closing the
   browser does not stop the engine. Use Cancel in the workspace to stop a
   job, or Ctrl+C in the runtime window to disconnect.

The container targets Intel/AMD and Apple Silicon computers. Windows and Linux
launchers are included; their complete installation flows have not been tested
in this workspace. Phones and
tablets can view the website and send work to an already connected computer;
they cannot run this native Python/Node engine by themselves. Installation is
required: a browser confirmation cannot start native Python processes.

### Developer setup with a local backend

Containers cannot reach the host's backend via `localhost`.
For Docker Desktop, set `DUNKAI_BACKEND_URL=http://host.docker.internal:4000`
and `DUNKAI_ALLOW_LOCAL_BACKEND=true` in `runtime/runtime.env`. On Linux, add
`--add-host=host.docker.internal:host-gateway` to the Docker run command.
This explicit opt-in allows HTTP on that development host only; deployed
backend URLs must use HTTPS.

## Existing Render backend

Set these variables and redeploy the existing service:

```dotenv
LOCAL_RUNTIME_ENABLED=true
AI_QUEUE_ENABLED=false
BILLING_ENABLED=false
DISABLE_CREDITS_FOR_TESTING=false
GROQ_API_KEY=<operator Groq key>
GROQ_MODEL=openai/gpt-oss-120b
GROQ_MAX_OUTPUT_TOKENS=8192
HF_TOKEN_READ=<read token for the rayyanshk/dunkai dataset>
BYOK_ENCRYPTION_KEY=<existing strong secret>
MONGODB_URI=<existing Atlas connection string>
FRONTEND_URL=https://YOUR-FRONTEND
CLIENT_ORIGIN=https://YOUR-FRONTEND
```

Keep existing JWT, OAuth, cookie, SMTP and upload storage settings. Verified
accounts are required for device pairing; configure SMTP or Google login.
Remove `BROWSER_COMPUTE_ONLY` and `GROQ_BROWSER_MODEL`. No supervisor URL/token
or Redis connection is needed in local mode. Atlas must support transactions
(Atlas clusters do). `render.yaml` provisions only a free Node service.

Build command from Render's `backend` root directory:

```sh
npm ci --omit=dev && npm run package:runtime
```

For a backend Docker build, generate the bundle first with
`cd backend && npm run package:runtime`; the Dockerfile copies `public/`.
The authenticated download endpoint reads that bundle. It contains source
files and examples, never `.env`, provider credentials, user data or caches.
Vercel still needs only `BACKEND_URL`, `NEXT_PUBLIC_BACKEND_URL` and
`NEXT_PUBLIC_SITE_URL` as shown in `frontend/.env.example`.

## Models and credits

Groq performs model inference remotely. The client's CPU/memory runs agent
orchestration, component retrieval, validation, PCB layout and rendering.
The small catalogue embedding model is cached locally; no local generative
language model is required.

- Local computation costs **0 DunkAI credits**, including PCB generation.
- Five **hosted model completions**, per verified account per UTC month, are
  free. These are model calls, not five complete projects or chat messages.
- Further successful hosted completions cost **2 credits each**. A pipeline
  can make multiple calls. Provider failures release the reservation;
  successful calls remain billable even if a later design stage fails.
- BYOK calls go from the user's runtime directly to Groq: **0 DunkAI credits**;
  the user's Groq account pays any provider charges.
- Local mode does not grant 150 new trial credits. Existing purchased balances
  remain usable. ₹200/₹500/₹1500 prepaid packs remain available when Stripe
  checkout is configured and `BILLING_ENABLED=true`.
- Closing checkout (`BILLING_ENABLED=false`) still enforces the hosted free
  quota. Only local development can set `DISABLE_CREDITS_FOR_TESTING=true`.

## Execution and security

Pairing uses a short-lived display code and a separate random device secret.
Only a verified account can approve a computer. Device tokens are hashed on
the server, expire after 30 days and can be revoked in Settings. A persisted
random job lease permits reconnecting the same runner; heartbeats expire jobs
when the computer disconnects. Devices can only claim their own user's jobs.

The companion exposes its inference proxy only on container loopback. Hosted
Groq and Hugging Face keys remain on the Node backend. SDK retry requests use
stable inference IDs so the same completion is not billed twice. Transient
provider failures release their reservation and can be retried after the
provider's delay; a completed response is replayed without another model call.
Completed
results are journaled locally before upload and can be published again without
rerunning the agents. The original agent logic and designer stay in use.
Saved BOM rows are recreated as a private local CSV before invoking the
original PCB agent. The original designer's `dist/` outputs are uploaded;
inherited boards are preserved across unrelated revisions and retired when
their components change. Before a separate board job, the companion restarts
the same supervisor to release catalogue/embedding RAM for the designer.
The backend allows the engine's configured primary, safety and fallback models
and caps output tokens per request. Override `GROQ_RUNTIME_MODELS` to restrict
this allowlist to models enabled on your operator account.

Generated code runs inside the existing bubblewrap sandbox with networking
and secrets removed. The launcher drops outer capabilities and enables
`no-new-privileges`. The launcher's seccomp/AppArmor/system-path exceptions
permit bubblewrap's inner user namespaces and isolated `/proc` mount. Docker's
default masked paths prevented that mount in the tested Docker Desktop setup;
the complete launcher flags passed the sandbox smoke test. See
[Docker's run security options](https://docs.docker.com/reference/cli/docker/container/run/#security-options).
The container is not privileged and mounts only its named data
volume, never the user's home directory. Sandbox preflight fails closed.
Do not publish port 8000 or mount sensitive host directories.

Supported board files are uploaded to private Atlas GridFS, with ownership
checks on uploads/downloads. Client-supplied output is marked unverified.
Gerber/manufacturing exports remain blocked until independent checks exist.
The computer's generated files remain in its Docker data volume; account
deletion/project deletion removes hosted results, not that local volume.

## Tests and operational limits

### Low memory computers

The current full Docker runtime is **not validated for a computer with 2 GB
total RAM**. The launcher still permits a 4 GB container; reducing that limit
alone can cause the engine to run out of memory.

The unused standalone catalogue embedding array is no longer downloaded or
loaded. The FAISS index already stores the vectors used for retrieval. For the
cached dataset measured here, this removes approximately **719 MiB of resident
array memory** and avoids a separate **719 MiB download** on new installations.
Existing cache files are retained; the runtime no longer reads that array.

This saving does not establish 2 GB support. The catalogue's Parquet data also
expands substantially in memory, and PyTorch and PCB evaluation consume more.
Reliable support at that target needs bounded disk-backed catalogue retrieval,
a lighter embedding runtime, and small-board limits validated on a 2 GB machine.
Render's free 512 MB instance also cannot hold the current ~719 MiB FAISS index.

### Code checks

```sh
ai_engine/venv/bin/python -m unittest discover -s ai_engine/agents/component_agent -p test_resource_loading.py
cd backend
npm run test:runtime
npm run test:database-dns
npm run test:credit-config
cd ../runtime
npm test
cd ../frontend
npm run typecheck
npm run build
```

Free hosting may sleep or impose storage/network quotas. Local computation
removes Python engine hosting cost; it does not make Groq usage unlimited.
An expired lease fails the job visibly rather than silently moving computation
to a server. Reconnect and retry. Each computer executes one job at a time.
Native firmware compilation still uses the existing optional backend compiler;
this local runtime currently relocates the AI and PCB pipeline.

### Validation in this workspace — 8 October 2026

- Frontend production build/typecheck and the Settings pairing/download/
  revocation UI test passed.
- Backend tests cover device ownership, expiring leases, completion, private
  GridFS uploads, quota concurrency, inference retries and actual call charges.
- The real Python supervisor performed its requirements interview through the
  companion proxy using mocked Groq responses. No provider quota was consumed.
- A separate real cached-catalogue test returned priced BOM rows and a schema
  2.0 PCB handoff on a later job. The agent code was used without replacement.
- Linux bubblewrap preflight passed under the launcher's final Docker flags.
- A real FAISS/Parquet fixture test confirmed unchanged search ordering, BOM
  prices and empty-taxonomy handling without the unused embedding-array file.
- The complete runtime image's dependency installation succeeded, but image
  export was stopped by a disk-space guard. Full Docker board generation and
  a live Groq run remain pending until a machine with adequate disk is available.
  The user selected finishing code checks while that validation is pending.

Optional native checks from `runtime/`, with the engine's Python dependencies
installed and the component dataset/embedding model already cached:

```sh
DUNKAI_NATIVE_TEST=true DUNKAI_PYTHON=../ai_engine/venv/bin/python npm test
DUNKAI_CATALOGUE_TEST=true HF_HUB_OFFLINE=1 DUNKAI_PYTHON=../ai_engine/venv/bin/python npm test
```

Saved browser-pipeline projects are retained. If their old handoff cannot be
read by the original engine, create a new chat and regenerate from your brief;
the removed browser artifact endpoints are not used for new designs.
