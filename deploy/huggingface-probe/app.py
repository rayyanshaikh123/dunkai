import spaces  # ZeroGPU must initialize before importing PyTorch libraries.
import gradio as gr
import numpy as np
from sentence_transformers import SentenceTransformer

from readiness import inspect_runtime


status = inspect_runtime()
# This is the same model the original component retriever uses. ZeroGPU's
# CUDA emulation supports placing the weights on cuda before a GPU request.
model = SentenceTransformer("BAAI/bge-small-en-v1.5", device="cuda")


@spaces.GPU(duration=15)
def check_embedding():
    vector = model.encode(
        "Temperature sensor with I2C interface and 3.3 V power",
        normalize_embeddings=True, convert_to_numpy=True,
    )
    return {"model": "BAAI/bge-small-en-v1.5", "dimensions": int(vector.shape[0]),
            "finite": bool(np.isfinite(vector).all()),
            "norm": float(np.linalg.norm(vector))}


with gr.Blocks() as demo:
    gr.Markdown("# DunkAI Spaces compatibility\n"
                "Prerequisites for the original engine. Full design generation has not been tested.")
    gr.JSON(value=status, label="Runtime prerequisites")
    gr.Markdown("The optional button tests a real component-query embedding and uses ZeroGPU quota.")
    button = gr.Button("Test component embedding")
    output = gr.JSON(label="Embedding result")
    button.click(check_embedding, inputs=[], outputs=output)


if __name__ == "__main__":
    demo.launch()
