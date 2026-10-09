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
BILLING_ENABLED=true
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

Stripe checkout is enabled using the configured **test-mode** credentials. The existing enabled test webhook points to `https://dunkai.onrender.com/api/v1/billing/webhook`. The generated Render file contains the Stripe secret key, webhook signing secret and configured email settings. A real Stripe test Checkout session for the INR 200 credit pack was created and verified, then expired without payment. The invalid local signing secret was replaced with the secret of a newly configured test webhook; import the regenerated Render file to activate it on the hosted backend. Test checkout cannot collect real money. For real payments, configure a live Stripe secret key and a matching live webhook signing secret; never reuse the test signing secret in live mode.

Credit pack sessions explicitly use direct Checkout (`managed_payments.enabled=false`). The account default previously rejected these sessions for missing Managed Payments product tax codes. See the [Stripe Checkout API reference](https://docs.stripe.com/api/checkout/sessions/create).

`AI_QUEUE_ENABLED=false` keeps the existing Node process executing jobs directly with MongoDB job records, credit reservations and interruption reconciliation. Stripe checkout does not require a separate Redis worker. If enabling the optional queue later, supply `REDIS_URL` and run its worker.

## Unlimited chats and welcome credits

Every user can create **unlimited chats**, with no monthly five-chat allowance.
Chat creation does not spend credits. AI operations use the published tariffs:
chat/interview replies cost 2 credits, a hosted design pipeline reserves up to 30,
and hosted Groq PCB generation costs 101. BYOK pipeline compute costs 10 and
board compute costs 20. Failed operations release their reservations. Existing
jobs already reserved under the old free-design policy retain their zero charge.

Verified accounts receive **500 free credits once**. This credit grant does not
renew monthly. Existing wallets are topped up to a lifetime grant of 500 using
their credit ledger: an account that previously received 150 gets 350 more,
preserving credits already spent, reserved, or purchased. Accounts with no prior
grant receive the full 500. Once the balance is depleted, users can still create
chats, but need more credits for billable AI work.

## Stripe credit recovery

Checkout returns include the Stripe session ID. Settings asks the authenticated
Node backend to confirm that session directly with Stripe, checks its owner,
amount, currency, metadata and environment mode against the saved order, and
adds the purchased credits atomically once. The same function handles signed
webhooks, so concurrent webhook delivery or page refresh cannot duplicate a grant.
**Refresh balance** also checks that user's pending orders, including purchases
made before session IDs were added to the return URL. The existing Node process
checks pending payments at startup and every five minutes while running.

Keep the webhook configured as the primary payment delivery mechanism. If it
returns `Invalid Stripe signature`, import the private
`deploy/dist/render-stripe.env` into Render (or copy its Stripe settings there)
and redeploy. Its signing secret belongs to the enabled webhook for
`https://dunkai.onrender.com/api/v1/billing/webhook`. Stripe CLI listener secrets
and other webhook endpoints' secrets are not interchangeable. The webhook route
must keep its raw-body parser before `express.json()`. Never publish the env file.

## 3. Publish the engine

```sh
python deploy/package_huggingface.py
python deploy/upload_huggingface.py
```

The uploader sets the Space secrets from ignored local files. The allowlist excludes credentials, dependencies and private project data. The Space source is currently public; keys belong in Space Secrets, never source files.

## 4. PCB sandbox readiness

### Compiler completion fix — 9 October 2026

The hosted sandbox can finish compilation and write artifacts while returning
an empty stdout stream with exit code 0. Parsing that stream as JSON caused
`Unexpected end of JSON input`; requiring an stdout event then caused
`Isolated board evaluator returned no result`.

The worker now commits `.sandbox-result.json` atomically after its outputs are
written. The parent deletes the previous manifest before every build, checks
the process exit status, validates the new manifest and output directory, and
checks its element/error counts against the actual `circuit.json`. Sandbox
enforcement remains enabled. Compiler progress is emitted by the parent.

The deployed fix completed the saved water-purifier BOM: 27 PCB traces, zero
compiler DRC errors, schematic/PCB SVGs, manufacturing outputs and a 3D model.
That BOM still has three unresolved components and two signal mismatches;
zero DRC errors do not establish a complete or electrically valid design.

PCB settings now default to **Auto · chat model**. The exact model accepted
for the chat pipeline is passed to board generation, including Groq and GPT
mini selections. New pipeline selections are saved on the chat for reloads
and retries. Old browser PCB preferences are replaced by Auto on the first
updated visit; users can explicitly choose a PCB override in Settings.
Deploy the corresponding Node and frontend changes to activate this setting.

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
