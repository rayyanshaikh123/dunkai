---
title: DunkAI - AI Hardware Copilot
emoji: 🏆
colorFrom: green
colorTo: yellow
sdk: gradio
sdk_version: "6.29.1"
python_version: "3.12"
app_file: app.py
startup_duration_timeout: 1h
pinned: false
license: apache-2.0
short_description: Original DunkAI design agents and PCB engine
---

# DunkAI AI engine

The original Python supervisor, component catalogue and Node PCB designer run
here. The existing website and Node API handle users, credits and project
storage. Language-model inference runs on Groq using hosted or BYOK credentials.

Set `SUPERVISOR_AGENT_TOKEN`, `GROQ_API_KEY` and `HF_TOKEN_READ` in **Space
Settings → Secrets**. Never commit `.env` files. Select Gradio/ZeroGPU hardware
for an eligible free account. No paid hardware is selected by this repository.

The main pipeline uses CPU component embeddings; the optional Gradio diagnostic
tests the same BGE model on ZeroGPU with its normal quota. The original agent
implementation is retained. Node 22 and designer dependencies are installed
on first startup. A passing Linux sandbox preflight is required for PCB layout.

`/health` reports readiness and PCB support. The supervisor API requires the
shared secret. A private Space additionally needs Hugging Face access at its
edge. Generation is serialized; cancellation or interruption stops the entire
engine process group. Generated files remain temporary until the Node backend
archives them in Atlas GridFS before acknowledging completion.

The build can succeed while PCB support is unavailable if Spaces blocks user
namespaces. The status reports that condition; isolation is never disabled.

See the DunkAI repository's `docs/HUGGING_FACE_SPACES_RUNBOOK.md` for backend
configuration, packaging/upload commands and live validation requirements.
