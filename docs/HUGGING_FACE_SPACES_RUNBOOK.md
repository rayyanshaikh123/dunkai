# Connect the hosted DunkAI services

## Verified status — 8 October 2026

The deployed Space reports `pcb_ready: true` with `landlock-seccomp enforcement and PCB compiler passed`. The actual host passed the isolation checks and compiled a small board through the original designer. Engine authentication and the Node health endpoint also passed. A complete model-driven requirements → BOM → PCB workflow has not yet been validated, so `complete_pcb_run_validated` remains false.

The Node Docker build now includes a tracked `backend/public/.gitkeep`, preventing `COPY public ./public` from failing in a clean checkout. Commit and deploy this file with the backend changes before applying the dashboard settings below. A full Docker build was not run locally because Docker is not running on this Mac.

## 1. Generate the connection files

From the repository root, with the Python environment activated:

```sh
python deploy/connect_huggingface.py
```

This updates `backend/.env.local` and creates two ignored files:

- `deploy/dist/render-huggingface.env`: engine URL, shared secret, read token and hosted execution settings. Contains credentials; keep it private.
- `deploy/dist/vercel-huggingface.env`: public frontend connection settings.

In Render, open **dunkai → Environment → Add from .env**, import the Render file, and save/redeploy. Preserve the existing MongoDB, JWT and BYOK encryption secrets. No Render API key is needed for dashboard updates.

In Vercel, open **dunkai → Settings → Environment Variables**, import the Vercel file for Production, and redeploy. Next.js reads the backend rewrite URL at build time.

The request path is **website → Node backend → authenticated Python Space → original agents**. Provider and Hugging Face keys must stay out of frontend environment variables.

## 2. Exact nonsecret settings

Render:

```dotenv
SUPERVISOR_AGENT_URL=https://rayyanshk-dunkai.hf.space
SUPERVISOR_AGENT_PATH=/api/v1/supervisor
LOCAL_RUNTIME_ENABLED=false
ARCHIVE_SUPERVISOR_ARTIFACTS=true
AI_QUEUE_ENABLED=false
BILLING_ENABLED=false
CREDIT_METERING_ENABLED=true
DISABLE_CREDITS_FOR_TESTING=false
FRONTEND_URL=https://dunkai.vercel.app
CLIENT_ORIGIN=https://dunkai.vercel.app
```

Also set `SUPERVISOR_AGENT_TOKEN` to the same secret as the Space. The generated file already contains it. `SUPERVISOR_HF_TOKEN` is a read token for private Space access; never use the write token here. Keeping it configured also works when the Space is public.

Vercel:

```dotenv
BACKEND_URL=https://dunkai.onrender.com
NEXT_PUBLIC_BACKEND_URL=https://dunkai.onrender.com
NEXT_PUBLIC_SITE_URL=https://dunkai.vercel.app
```

Stripe checkout stays disabled for this pilot; model quotas remain enforced. Enabling payments later requires the launch runbook's Stripe and worker setup.

## 3. Publish the engine

```sh
python deploy/package_huggingface.py
python deploy/upload_huggingface.py
```

The uploader sets the Space secrets from ignored local files. The allowlist excludes credentials, dependencies and private project data. The Space source is currently public; keys belong in Space Secrets, never source files.

## 4. PCB sandbox readiness

```sh
curl https://rayyanshk-dunkai.hf.space/health
python deploy/check_huggingface.py
```

`status: ok` means the API is running. PCB generation additionally requires `pcb_ready: true`.

The preferred evaluator sandbox uses bubblewrap's mount, process and network namespaces. When the host denies namespaces, the Space tests a Linux Landlock + libseccomp alternative. This alternative requires Landlock ABI 3 or newer, restricts file access to the trusted toolchain and current board directory, strips credentials, denies network syscalls and process creation, and bounds evaluation time, output file size and Node heap. Its startup check tests outside-file access, symlink escape, source writes, truncation, sockets, process creation, thread support and an actual small PCB compilation.

If either kernel enforcement or compilation fails, PCB generation remains unavailable and reports the reason. **Do not set `BOARD_SANDBOX_REQUIRED=false`.** A denied kernel feature cannot be enabled through a normal Space environment variable. Landlock compatibility must be confirmed on the actual host; a sandbox check does not validate arbitrary generated circuits for manufacture.

`complete_pcb_run_validated` remains false until an entire original agent workflow has actually been tested. Startup compiler checks alone do not establish that.

## 5. Storage and operational limits

The Space handles one job at a time; concurrent users receive a retry message. Free Spaces can sleep or restart. Generated results are archived by Node into private MongoDB GridFS before completion, subject to storage quotas; Space files alone are ephemeral. Existing saved data is preserved when importing only the connection settings.

After redeploy, create a new requirements chat on the website, complete its interview, inspect the BOM prices, and generate a board. Confirm that archived schematic/PCB links still work after restarting the Space. Neither firmware compilation on Render nor fabrication safety is established by engine health checks.
