# Hugging Face Spaces — free-account feasibility and deployment plan

Checked against the official documentation on 8 October 2026.

## Available route with a ₹0 account

New ordinary Docker and Gradio compute Spaces require a paid account plan.
CPU Basic's lack of an hourly hardware charge does not remove that account
requirement. The free exception is **up to two Gradio ZeroGPU Spaces** for
personal accounts in good standing: verified email and account older than
30 days. ZeroGPU only supports the Gradio SDK, not Docker.

Sources: [Spaces overview](https://huggingface.co/docs/hub/spaces-overview),
[ZeroGPU eligibility and compatibility](https://huggingface.co/docs/hub/spaces-zerogpu).

The free route is a compatibility candidate, not a validated hosting solution
for DunkAI's complete pipeline. Its GPU capacity does not establish support
for the original Node designer or the Linux sandbox.

## First: validate the platform

1. Create a Gradio Space under the eligible personal account and select
   ZeroGPU hardware in the creation flow/settings.
2. Upload the five deployment files from `deploy/huggingface-probe/` as
   described in that folder's README. No keys or engine data are uploaded.
3. Check `node_22_or_newer` and `pcb_sandbox_preflight_passed`. Debian's `nodejs`
   package may be older than the designer's target; if so the full adapter
   must install a pinned Node 22 distribution during its build/startup.
4. Optionally test the actual BGE embedding. This uses normal ZeroGPU quota
   and validates that embedding computation can run, not catalogue selection.
5. Keep the Space URL and result. A failed bubblewrap check is a blocker for
   the current PCB evaluator. Do not disable its isolation to make a demo pass.

The probe's readiness logic has local fixture tests; the Space itself has not
been deployed or validated in this workspace. Its Gradio/PyTorch/ZeroGPU
integration needs the live platform check. No subscription was purchased.

## Intended complete deployment after that check

```text
Existing frontend -> existing Node API -> authenticated Gradio Space adapter
                                              |
                                  original Python supervisor/agents
                                              |
                                  original Node dunkai-designer
```

Groq still performs language-model inference remotely with the operator's
key or the authenticated user's BYOK credentials. The Space runs computation;
users need only the website, with no local installation. Atlas stays connected
to the Node API. Spaces outbound networking supports ports 80/443/8080; do not
move the Atlas connection into the Space.

The full adapter must reuse the original agents and implement:

- Gradio-compatible hosting around the original FastAPI endpoints, with one
  active generation job at a time and visible busy/cold-start responses.
- The existing shared supervisor secret on every execution/artifact endpoint.
  Public Space source must contain no `.env`, private data, or credentials.
- Original Groq/BYOK request handling, usage capture, and backend credit/quota
  enforcement. Hosted mode must not silently make platform inference unlimited
  when Stripe checkout is disabled.
- Node 22, original designer dependencies and a passing sandbox preflight.
- Durable result storage through the existing Node API/Atlas GridFS before
  reporting success. Space disk is a cache/workspace, not the only copy of a
  user's board. Preserve private download and fabrication-export checks.
- Job status/reconnect/cancellation and interruption handling. Sleeping or
  restarting the Space must not silently lose a running job or charge it twice.

Only after those changes and a complete live run should the backend switch
to `LOCAL_RUNTIME_ENABLED=false` and point `SUPERVISOR_AGENT_URL` at the
validated Space URL. `SUPERVISOR_AGENT_TOKEN` must match its Space secret.
The existing client-runtime configuration continues to be the implemented
execution route while Spaces compatibility is being evaluated.

## Release checks

Run requirements interview -> architecture -> priced catalogue BOM -> schema
2.0 handoff -> schematic/PCB previews through the original agents. Then test
ownership isolation, invalid supervisor auth, BYOK, hosted quota exhaustion,
cancellation, concurrent users, Space sleep/restart and retained artifacts.

If the free ZeroGPU host cannot support the sandbox, full PCB execution needs
a supported host or specifically approved sponsored hosting. A grant or a paid
Docker Space is not presumed available to this free account.

Additional references: [Docker Spaces](https://huggingface.co/docs/hub/spaces-sdks-docker),
[Space networking/secrets/lifecycle](https://huggingface.co/docs/hub/spaces-overview).
