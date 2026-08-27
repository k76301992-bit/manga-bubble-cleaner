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
import cv2
import torch
import uvicorn
from fastapi import FastAPI, HTTPException
from fastapi.responses import Response
from PIL import Image
from pydantic import BaseModel

MODEL_URL = "https://github.com/Sanster/models/releases/download/AnimeMangaInpainting/anime-manga-big-lama.pt"
MODEL_MD5 = "29f284f36a0a510bcacf39ecf4c4d54f"
MODEL_PATH = Path(os.environ.get("ANIME_LAMA_MODEL_PATH", "/home/ubuntu/.cache/torch/hub/checkpoints/anime-manga-big-lama.pt"))
TEXT_DETECTOR_PATH = Path(os.environ.get("COMIC_TEXT_DETECTOR_PATH", str(Path(__file__).resolve().parent / "models" / "comictextdetector.pt.onnx")))
MAX_PAYLOAD_BYTES = 8 * 1024 * 1024


class InpaintPayload(BaseModel):
  image: str
  mask: str


class TextDetectionPayload(BaseModel):
    image: str
    includeTextMask: bool = False


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


class ComicTextDetector:
    def __init__(self):
        self.net = None
        self.lock = threading.Lock()
        self.load_time_ms = 0

    def load(self) -> None:
        if self.net is not None:
            return
        if not TEXT_DETECTOR_PATH.exists():
            raise RuntimeError("Comic text detector model is unavailable")
        started = time.monotonic()
        self.net = cv2.dnn.readNetFromONNX(str(TEXT_DETECTOR_PATH))
        self.load_time_ms = round((time.monotonic() - started) * 1000)
        print(f"[inference] Comic text detector ready in {self.load_time_ms}ms")

    @staticmethod
    def _letterbox(image: np.ndarray) -> tuple[np.ndarray, float, int, int]:
        height, width = image.shape[:2]
        ratio = min(1024 / width, 1024 / height)
        resized_width, resized_height = round(width * ratio), round(height * ratio)
        canvas = np.full((1024, 1024, 3), 114, dtype=np.uint8)
        canvas[:resized_height, :resized_width] = cv2.resize(image, (resized_width, resized_height), interpolation=cv2.INTER_LINEAR)
        return canvas, ratio, resized_width, resized_height

    def _detect_window(self, source: np.ndarray, offset_x: int, offset_y: int, include_text_mask: bool) -> tuple[list[dict[str, int | float]], np.ndarray | None]:
        image, ratio, resized_width, resized_height = self._letterbox(source)
        blob = cv2.dnn.blobFromImage(image, scalefactor=1 / 255.0, size=(1024, 1024), swapRB=True, crop=False)
        with self.lock:
            self.net.setInput(blob)
            outputs = self.net.forward(["blk", "det", "seg"] if include_text_mask else ["blk"])
        blocks = np.asarray(outputs[0] if include_text_mask else outputs, dtype=np.float32).reshape(-1, 7)
        text_mask = None
        if include_text_mask:
            seg = np.asarray(outputs[2], dtype=np.float32)[0, 0, :resized_height, :resized_width]
            text_mask = (cv2.resize(seg, (source.shape[1], source.shape[0]), interpolation=cv2.INTER_LINEAR) >= 0.30).astype(np.uint8) * 255
        candidates: list[tuple[list[int], float, int]] = []
        for row in blocks:
            center_x, center_y, box_width, box_height, objectness = row[:5]
            classes = row[5:]
            if not len(classes):
                continue
            class_id = int(np.argmax(classes))
            confidence = float(objectness * classes[class_id])
            if confidence >= 0.40 and box_width >= 5 and box_height >= 5:
                candidates.append(([round(center_x - box_width / 2), round(center_y - box_height / 2), round(box_width), round(box_height)], confidence, class_id))
        if not candidates:
            return [], text_mask
        indices = cv2.dnn.NMSBoxes([box for box, _, _ in candidates], [score for _, score, _ in candidates], score_threshold=0.40, nms_threshold=0.35)
        regions: list[dict[str, int | float]] = []
        for index in np.asarray(indices).reshape(-1):
            left, top, box_width, box_height = candidates[int(index)][0]
            x0 = max(0, min(source.shape[1] - 1, round(left / ratio))) + offset_x
            y0 = max(0, min(source.shape[0] - 1, round(top / ratio))) + offset_y
            x1 = max(x0 + 1, min(offset_x + source.shape[1], round((left + box_width) / ratio) + offset_x))
            y1 = max(y0 + 1, min(offset_y + source.shape[0], round((top + box_height) / ratio) + offset_y))
            regions.append({"x": x0, "y": y0, "width": x1 - x0, "height": y1 - y0, "confidence": round(candidates[int(index)][1], 3), "class": candidates[int(index)][2]})
        return regions, text_mask

    @staticmethod
    def _overlaps(left: dict[str, int | float], right: dict[str, int | float]) -> bool:
        intersection = max(0, min(int(left["x"]) + int(left["width"]), int(right["x"]) + int(right["width"])) - max(int(left["x"]), int(right["x"]))) * max(0, min(int(left["y"]) + int(left["height"]), int(right["y"]) + int(right["height"])) - max(int(left["y"]), int(right["y"])))
        smaller = max(1, min(int(left["width"]) * int(left["height"]), int(right["width"]) * int(right["height"])))
        return intersection / smaller >= 0.55

    def detect(self, image_bytes: bytes, include_text_mask: bool = False) -> tuple[list[dict[str, int | float]], int, np.ndarray | None]:
        if not image_bytes or len(image_bytes) > MAX_PAYLOAD_BYTES:
            raise ValueError("Input image exceeds the private text detection limit")
        self.load()
        source = np.asarray(Image.open(io.BytesIO(image_bytes)).convert("RGB"))[:, :, ::-1].copy()
        started = time.monotonic()
        window_size, overlap = 2048, 256
        starts = list(range(0, max(1, source.shape[0] - window_size + 1), window_size - overlap))
        final_start = max(0, source.shape[0] - window_size)
        if final_start not in starts:
            starts.append(final_start)
        candidates: list[dict[str, int | float]] = []
        text_mask = np.zeros(source.shape[:2], dtype=np.uint8) if include_text_mask else None
        for top in sorted(set(starts)):
            bottom = min(source.shape[0], top + window_size)
            window_regions, window_mask = self._detect_window(source[top:bottom], 0, top, include_text_mask)
            candidates.extend(window_regions)
            if text_mask is not None and window_mask is not None:
                text_mask[top:bottom] = np.maximum(text_mask[top:bottom], window_mask)
        regions: list[dict[str, int | float]] = []
        for candidate in sorted(candidates, key=lambda region: float(region["confidence"]), reverse=True):
            if not any(self._overlaps(candidate, existing) for existing in regions):
                regions.append(candidate)
        return sorted(regions, key=lambda region: (int(region["y"]), int(region["x"]))), round((time.monotonic() - started) * 1000), text_mask


engine = AnimeLamaEngine()
text_detector = ComicTextDetector()


@asynccontextmanager
async def lifespan(_app: FastAPI):
    engine.load()
    yield


app = FastAPI(title="Manga Bubble Cleaner Inference", docs_url=None, redoc_url=None, lifespan=lifespan)


@app.get("/health")
def health():
    return {"ok": engine.model is not None, "model": "anime-manga-big-lama", "loadTimeMs": engine.load_time_ms, "textDetectorReady": text_detector.net is not None, "imagesPersisted": False}


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


@app.post("/v1/detect-text")
def detect_text(payload: TextDetectionPayload):
    try:
        image_bytes = base64.b64decode(payload.image, validate=True)
        regions, elapsed_ms, text_mask = text_detector.detect(image_bytes, payload.includeTextMask)
        response = {"regions": regions, "elapsedMs": elapsed_ms}
        if text_mask is not None:
            encoded = io.BytesIO()
            Image.fromarray(text_mask, "L").save(encoded, format="PNG", optimize=False)
            response["textMask"] = base64.b64encode(encoded.getvalue()).decode("ascii")
        return response
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    except Exception as error:
        print(f"[inference] text detection failed: {error}")
        raise HTTPException(status_code=503, detail="Private text detection service is temporarily unavailable") from error


if __name__ == "__main__":
    uvicorn.run(app, host=os.environ.get("INFERENCE_HOST", "127.0.0.1"), port=int(os.environ.get("INFERENCE_PORT", "8090")), log_level="warning")
