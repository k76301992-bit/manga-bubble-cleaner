import cv2
import numpy as np
from pathlib import Path
from datetime import datetime


ROOT = Path("/home/ubuntu/manga-bubble-cleaner-retained-fixtures/drive-result-evaluation")
SOURCE = ROOT / "originals"
DESTINATION = ROOT / "full-page-text-segmentation" / datetime.now().isoformat(timespec="seconds").replace(":", "-")
MODEL = "server/inference-service/models/comictextdetector.pt.onnx"


def letterbox(image: np.ndarray) -> tuple[np.ndarray, float, int, int, int, int]:
    height, width = image.shape[:2]
    ratio = min(1024 / width, 1024 / height)
    resized_width, resized_height = round(width * ratio), round(height * ratio)
    resized = cv2.resize(image, (resized_width, resized_height), interpolation=cv2.INTER_AREA if ratio < 1 else cv2.INTER_CUBIC)
    left, top = (1024 - resized_width) // 2, (1024 - resized_height) // 2
    canvas = np.full((1024, 1024, 3), 114, dtype=np.uint8)
    canvas[top:top + resized_height, left:left + resized_width] = resized
    return canvas, ratio, left, top, resized_width, resized_height


def window_starts(height: int, window_size: int = 2048, overlap: int = 256) -> list[int]:
    starts = list(range(0, max(1, height - window_size + 1), window_size - overlap))
    starts.append(max(0, height - window_size))
    return sorted(set(starts))


def main() -> None:
    DESTINATION.mkdir(parents=True, exist_ok=True)
    net = cv2.dnn.readNetFromONNX(MODEL)
    report = []
    for path in sorted(item for item in SOURCE.iterdir() if item.suffix.lower() in {".jpeg", ".jpg", ".png", ".webp"}):
        source = cv2.imread(str(path), cv2.IMREAD_COLOR)
        mask = np.zeros(source.shape[:2], dtype=np.uint8)
        for top in window_starts(source.shape[0]):
            window = source[top:min(source.shape[0], top + 2048)]
            canvas, ratio, left, pad_top, resized_width, resized_height = letterbox(window)
            blob = cv2.dnn.blobFromImage(canvas, scalefactor=1 / 255.0, size=(1024, 1024), swapRB=True, crop=False)
            net.setInput(blob)
            seg = net.forward(["seg"])[0][0, 0]
            seg = seg[pad_top:pad_top + resized_height, left:left + resized_width]
            restored = cv2.resize(seg, (window.shape[1], window.shape[0]), interpolation=cv2.INTER_LINEAR)
            mask[top:top + window.shape[0]] = np.maximum(mask[top:top + window.shape[0]], (restored >= 0.30).astype(np.uint8) * 255)
        cv2.imwrite(str(DESTINATION / f"{path.name}.mask.png"), mask)
        overlay = source.copy()
        overlay[mask > 0] = (0, 0, 255)
        composite = cv2.addWeighted(source, 0.68, overlay, 0.32, 0)
        cv2.imwrite(str(DESTINATION / f"{path.name}.overlay.png"), composite)
        report.append({"name": path.name, "textMaskPixels": int(np.count_nonzero(mask))})
    print({"outputDir": str(DESTINATION), "pages": report})


if __name__ == "__main__":
    main()
