---
title: DunkAI runtime compatibility
emoji: 🔧
colorFrom: blue
colorTo: gray
sdk: gradio
python_version: "3.12"
app_file: app.py
pinned: false
short_description: Check the original engine prerequisites on Spaces
---

# DunkAI Spaces compatibility check

This checks prerequisites for the existing Python/Node engine. It is **not**
the design engine, and it does not expose Groq or use your project data.

For a free personal account, create a **Gradio** Space and choose **ZeroGPU**
hardware. Your email must be verified and the account must be older than
30 days. New ordinary Gradio/Docker compute Spaces require a paid plan.
See the [current ZeroGPU eligibility](https://huggingface.co/docs/hub/spaces-zerogpu).

Upload `README.md`, `app.py`, `readiness.py`, `requirements.txt` and
`packages.txt` from this folder. No secrets are needed. The status is computed
once at startup; it checks the Node version and the Linux bubblewrap sandbox.
The optional embedding button performs a real BGE query embedding on ZeroGPU
and uses its normal GPU quota. It does not run a language model.

Passing this check is necessary, but does not validate complete PCB generation.
If bubblewrap is denied by the host, the original PCB evaluator cannot run
here with its current isolation. Keep that gate enabled.

Return the Space URL and the displayed status before connecting the hosted
backend. See `docs/HUGGING_FACE_SPACES_PLAN.md` in the DunkAI repository for the
full integration steps and remaining validation.
