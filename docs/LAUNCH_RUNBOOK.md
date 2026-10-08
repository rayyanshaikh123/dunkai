# Launch runbook — local AI engine

Use [LOCAL_RUNTIME.md](LOCAL_RUNTIME.md) for installation, environment values,
pricing and security controls. The browser pipeline has been removed. Keep
existing hosted frontend, Node backend and Atlas; deploy the updated Node API
and website, then each user pairs their own computer in Settings.

## Deployment order

1. Backend: set `LOCAL_RUNTIME_ENABLED=true`, `AI_QUEUE_ENABLED=false`, the
   existing auth secrets, `GROQ_API_KEY`, `GROQ_MODEL` and `HF_TOKEN_READ`.
2. Set the Render build command to `npm ci --omit=dev && npm run package:runtime`
   with root directory `backend`; start with `npm start`. No AI worker or
   separate Python service is required. Do not replace existing auth secrets.
3. Frontend: retain `BACKEND_URL`, `NEXT_PUBLIC_BACKEND_URL` and
   `NEXT_PUBLIC_SITE_URL`; remove any old browser-compute build flag and redeploy.
4. Sign in with a verified account. Download/start the runtime and enter the
   displayed pairing code in Settings. Wait for Ready before generating.
5. Test a complete requirements → architecture → catalogue BOM → PCB handoff →
   board run. Check catalogue unit prices, progress, previews and reload.
6. Test cancellation, stopping/restarting the runtime, revocation, a second
   account's access denial, free quota exhaustion and the visible credit error.

## Paid checkout

Keep `BILLING_ENABLED=false` while validating the local pipeline. Hosted model
quotas remain active. Before enabling purchases, configure Stripe India test
mode, signed webhook delivery, real account verification/SMTP, tax/invoicing
and refund/dispute behavior. See the historical pricing audit in
[PCB_CREDITS_LAUNCH_PLAN.md](PCB_CREDITS_LAUNCH_PLAN.md).

No infrastructure or Stripe account has been deployed from this workspace.
Free service quotas and Groq usage still apply. Local CPU work removes the
separate AI-engine hosting cost; it does not guarantee unlimited zero-cost
operations or certify generated hardware.
