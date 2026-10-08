# Launch runbook — hosted Hugging Face engine

Use [HUGGING_FACE_SPACES_RUNBOOK.md](HUGGING_FACE_SPACES_RUNBOOK.md) for the active hosted deployment. The website and Node backend remain on Vercel/Render; Atlas stores accounts, quotas, charges and archived board files. The original Python supervisor and designer run on the Hugging Face Space.

## Deployment order

1. Commit/deploy the backend and frontend updates.
2. Run `python deploy/connect_huggingface.py` and import the generated private `deploy/dist/render-huggingface.env` file into the existing Render service. Preserve existing database and authentication secrets.
3. Import `deploy/dist/vercel-huggingface.env` into Vercel and redeploy. It contains public URLs only.
4. Verify engine health and authentication with `python deploy/check_huggingface.py`.
5. With a verified account, start a new chat and complete requirements → architecture → catalogue BOM → PCB handoff → board. The first five chats each month include one pipeline and one PCB at zero credits.
6. Verify a failed included run can retry, a completed extra board is quoted, and a sixth chat needs credits. Confirm previews remain accessible after a Space restart.

## Stripe checkout

`BILLING_ENABLED=true` enables the existing INR prepaid packs. Current credentials and the enabled hosted webhook are **test mode**, so no real money is collected. The webhook URL is `https://dunkai.onrender.com/api/v1/billing/webhook`; payment grants are verified and idempotent. Real payments require a live secret key and a matching live-mode webhook signing secret.

Checkout uses the current Node process and Atlas transactions with `AI_QUEUE_ENABLED=false`; Redis and a separate worker are optional. Interrupted jobs are reconciled and their outstanding reservations released. Existing balances remain unchanged.

For the alternative companion installation, see [LOCAL_RUNTIME.md](LOCAL_RUNTIME.md). That mode uses a separate per-model-call allowance; the hosted five-design-chat offer applies when `LOCAL_RUNTIME_ENABLED=false`.
