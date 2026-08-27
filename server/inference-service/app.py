"""Private, memory-only Anime-Manga Big-LaMa inference sidecar.

The service binds to localhost only. It accepts a PNG/WebP/JPEG crop plus a
binary mask, keeps the TorchScript model resident after startup, and returns a
PNG. Neither input nor output is written to disk.
"""

import base64
import hashlib
import io
import os
import threading
import time
from contextlib import asynccontextmanager
from pathlib import Path

import numpy as np
import torch
import uvicorn
from fastapi import FastAPI, HTTPException
from fastapi.responses import Response
from PIL import Image
from pydantic import BaseModel

MODEL_URL = "https://github.com/Sanster/models/releases/download/AnimeMangaInpainting/anime-manga-big-lama.pt"
MODEL_MD5 = "29f284f36a0a510bcacf39ecf4c4d54f"
MODEL_PATH = Path(os.environ.get("ANIME_LAMA_MODEL_PATH", "/home/ubuntu/.cache/torch/hub/checkpoints/anime-manga-big-lama.pt"))
MAX_PAYLOAD_BYTES = 8 * 1024 * 1024


class InpaintPayload(BaseModel):
    image: str
    mask: str


class AnimeLamaEngine:
    def __init__(self):
        self.model = None
        self.lock = threading.Lock()
        self.load_time_ms = 0

    def _download_model(self) -> None:
        import urllib.request

        MODEL_PATH.parent.mkdir(parents=True, exist_ok=True)
        temporary_path = MODEL_PATH.with_suffix(".download")
        print(f"[inference] downloading Anime-Manga Big-LaMa to {MODEL_PATH}")
        urllib.request.urlretrieve(MODEL_URL, temporary_path)
        digest = hashlib.md5(temporary_path.read_bytes()).hexdigest()
        if digest != MODEL_MD5:
            temporary_path.unlink(missing_ok=True)
            raise RuntimeError("Anime-Manga Big-LaMa checksum validation failed")
        temporary_path.replace(MODEL_PATH)

    def load(self) -> None:
        if self.model is not None:
            return
        started = time.monotonic()
        if not MODEL_PATH.exists():
            self._download_model()
        self.model = torch.jit.load(str(MODEL_PATH), map_location="cpu").eval()
        self.load_time_ms = round((time.monotonic() - started) * 1000)
        print(f"[inference] Anime-Manga Big-LaMa ready in {self.load_time_ms}ms")

    def inpaint(self, image_bytes: bytes, mask_bytes: bytes) -> tuple[bytes, int]:
        if self.model is None:
            raise RuntimeError("Inference model is not ready")
        if not image_bytes or len(image_bytes) > MAX_PAYLOAD_BYTES or not mask_bytes or len(mask_bytes) > MAX_PAYLOAD_BYTES:
            raise ValueError("Input crop or mask exceeds the private inference limit")

        source = np.asarray(Image.open(io.BytesIO(image_bytes)).convert("RGB"))
        mask = np.asarray(Image.open(io.BytesIO(mask_bytes)).convert("L"))
        if source.shape[:2] != mask.shape[:2]:
            raise ValueError("Image and mask sizes must match")
        if not np.any(mask > 127):
            return image_bytes, 0

        started = time.monotonic()
        height, width = source.shape[:2]
        padded_h = (height + 7) // 8 * 8
        padded_w = (width + 7) // 8 * 8
        padded_source = np.pad(source, ((0, padded_h - height), (0, padded_w - width), (0, 0)), mode="symmetric")
        padded_mask = np.pad(mask, ((0, padded_h - height), (0, padded_w - width)), mode="symmetric")

        image_tensor = torch.from_numpy(np.ascontiguousarray(padded_source.transpose(2, 0, 1))).float().div(255).unsqueeze(0)
        mask_tensor = torch.from_numpy(np.ascontiguousarray((padded_mask > 127).astype(np.float32))).unsqueeze(0).unsqueeze(0)
        with self.lock, torch.inference_mode():
            generated = self.model(image_tensor, mask_tensor)
        result = generated[0].permute(1, 2, 0).detach().cpu().numpy()
        result = np.clip(result * 255, 0, 255).astype(np.uint8)[:height, :width]
        # Model output must not alter art outside the explicit text mask.
        result[mask <= 127] = source[mask <= 127]
        buffer = io.BytesIO()
        Image.fromarray(result, "RGB").save(buffer, format="PNG", optimize=False)
        return buffer.getvalue(), round((time.monotonic() - started) * 1000)


engine = AnimeLamaEngine()


@asynccontextmanager
async def lifespan(_app: FastAPI):
    engine.load()
    yield


app = FastAPI(title="Manga Bubble Cleaner Inference", docs_url=None, redoc_url=None, lifespan=lifespan)


@app.get("/health")
def health():
    return {"ok": engine.model is not None, "model": "anime-manga-big-lama", "loadTimeMs": engine.load_time_ms, "imagesPersisted": False}


@app.post("/v1/inpaint")
def inpaint(payload: InpaintPayload):
    try:
        image_bytes = base64.b64decode(payload.image, validate=True)
        mask_bytes = base64.b64decode(payload.mask, validate=True)
        output, elapsed_ms = engine.inpaint(image_bytes, mask_bytes)
        return Response(content=output, media_type="image/png", headers={"Cache-Control": "no-store", "X-Inference-Time-Ms": str(elapsed_ms)})
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    except Exception as error:
        print(f"[inference] request failed: {error}")
        raise HTTPException(status_code=503, detail="Private inpainting service is temporarily unavailable") from error


if __name__ == "__main__":
    uvicorn.run(app, host=os.environ.get("INFERENCE_HOST", "127.0.0.1"), port=int(os.environ.get("INFERENCE_PORT", "8090")), log_level="warning")
