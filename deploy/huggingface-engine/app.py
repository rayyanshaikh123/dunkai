import spaces  # Initialize ZeroGPU before importing PyTorch.
import os
from pathlib import Path

import gradio as gr
import numpy as np
import uvicorn
from sentence_transformers import SentenceTransformer

from adapter import EngineProcess, create_app
from bootstrap import install_designer, sandbox_status


root = Path(__file__).resolve().parent
state = Path(os.environ.get("DUNKAI_SPACE_STATE", "/tmp/dunkai-space"))
state.mkdir(parents=True, exist_ok=True, mode=0o700)
token = os.environ.get("SUPERVISOR_AGENT_TOKEN", "")
binary = install_designer(root, state)
pcb_ready, reason = sandbox_status(binary, root / "dunkai-designer")
engine = EngineProcess(root, state, token)
app = create_app(engine, token, pcb_ready=pcb_ready, pcb_reason=reason)

# The public UI contains only deployment status and a real embedding diagnostic.
# It never accepts design jobs or provider keys; those go through the Node API.
embedding_model = SentenceTransformer("BAAI/bge-small-en-v1.5", device="cuda")


@spaces.GPU(duration=15)
def check_embedding():
    vector = embedding_model.encode("Temperature sensor with I2C and 3.3 V power",
                                    normalize_embeddings=True, convert_to_numpy=True)
    return {"dimensions": int(vector.shape[0]), "finite": bool(np.isfinite(vector).all()),
            "norm": float(np.linalg.norm(vector))}


with gr.Blocks() as demo:
    gr.Markdown("# DunkAI engine\nUse the DunkAI website to create designs.")
    gr.JSON(value={"configured": bool(token), "pcb_ready": pcb_ready, "pcb_reason": reason}, label="Deployment status")
    gr.Markdown("Optional diagnostic: tests a real BGE component embedding using ZeroGPU quota.")
    result = gr.JSON(label="Embedding result")
    gr.Button("Test component embedding").click(check_embedding, inputs=[], outputs=result)

app = gr.mount_gradio_app(app, demo, path="/")

if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=7860)
