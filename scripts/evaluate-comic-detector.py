import json
from pathlib import Path

import cv2
import numpy as np


ROOT = Path("/home/ubuntu/manga-bubble-cleaner")
MODEL_PATH = ROOT / "server/inference-service/models/comictextdetector.pt.onnx"
IMAGE_PATH = ROOT / "test-fixtures/user-chapter/source-pages/196 [stitched]/01.jpg"
OUTPUT_PATH = ROOT / "test-fixtures/user-chapter/detector-probe-01.json"
INPUT_SIZE = 1024


def letterbox(image: np.ndarray) -> tuple[np.ndarray, float, int, int]:
    height, width = image.shape[:2]
    ratio = min(INPUT_SIZE / width, INPUT_SIZE / height)
    new_width, new_height = round(width * ratio), round(height * ratio)
    canvas = np.full((INPUT_SIZE, INPUT_SIZE, 3), 114, dtype=np.uint8)
    canvas[:new_height, :new_width] = cv2.resize(image, (new_width, new_height), interpolation=cv2.INTER_LINEAR)
    return canvas, ratio, INPUT_SIZE - new_width, INPUT_SIZE - new_height


def detect_tile(net: cv2.dnn.Net, image: np.ndarray) -> list[dict[str, float]]:
    boxed, ratio, _, _ = letterbox(image)
    blob = cv2.dnn.blobFromImage(boxed, scalefactor=1 / 255.0, size=(INPUT_SIZE, INPUT_SIZE), swapRB=True, crop=False)
    net.setInput(blob)
    blocks = np.asarray(net.forward(["blk"]), dtype=np.float32).reshape(-1, 7)
    candidates: list[tuple[list[int], float, int]] = []
    for row in blocks:
        center_x, center_y, width, height, objectness = row[:5]
        classes = row[5:]
        if not len(classes):
            continue
        class_id = int(np.argmax(classes))
        confidence = float(objectness * classes[class_id])
        if confidence < 0.40 or width < 5 or height < 5:
            continue
        left, top = center_x - width / 2, center_y - height / 2
        candidates.append(([round(left), round(top), round(width), round(height)], confidence, class_id))
    indices = cv2.dnn.NMSBoxes([box for box, _, _ in candidates], [score for _, score, _ in candidates], score_threshold=0.40, nms_threshold=0.35)
    detected: list[dict[str, float]] = []
    for index in np.array(indices).reshape(-1) if len(indices) else []:
        left, top, width, height = candidates[int(index)][0]
        x0 = max(0, min(image.shape[1] - 1, round(left / ratio))); y0 = max(0, min(image.shape[0] - 1, round(top / ratio)))
        x1 = max(x0 + 1, min(image.shape[1], round((left + width) / ratio))); y1 = max(y0 + 1, min(image.shape[0], round((top + height) / ratio)))
        detected.append({"x": x0, "y": y0, "width": x1 - x0, "height": y1 - y0, "confidence": round(candidates[int(index)][1], 3), "class": candidates[int(index)][2]})
    return sorted(detected, key=lambda item: (item["y"], item["x"]))


def main() -> None:
    image = cv2.imread(str(IMAGE_PATH), cv2.IMREAD_COLOR)
    if image is None:
        raise RuntimeError("Chapter fixture is unavailable")
    net = cv2.dnn.readNetFromONNX(str(MODEL_PATH))
    tiles: list[dict[str, object]] = []
    for index, top in enumerate(range(0, image.shape[0], 2400)):
        boxes = detect_tile(net, image[top:top + 2400])
        tiles.append({"tile": index + 1, "top": top, "boxes": boxes})
    OUTPUT_PATH.write_text(json.dumps({"image": str(IMAGE_PATH), "tiles": tiles}, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"tiles": len(tiles), "boxes": sum(len(tile["boxes"]) for tile in tiles), "output": str(OUTPUT_PATH)}, ensure_ascii=False))


if __name__ == "__main__":
    main()
