from pathlib import Path

import cv2
import numpy as np


MODEL_PATH = Path("/home/ubuntu/manga-bubble-cleaner/server/inference-service/models/comictextdetector.pt.onnx")
IMAGE_PATH = Path("/home/ubuntu/manga-bubble-cleaner/test-fixtures/user-chapter/source-pages/196 [stitched]/01.jpg")


def letterbox(image: np.ndarray, size: int = 1024) -> tuple[np.ndarray, float, int, int]:
    height, width = image.shape[:2]
    ratio = min(size / width, size / height)
    new_width = int(round(width * ratio))
    new_height = int(round(height * ratio))
    resized = cv2.resize(image, (new_width, new_height), interpolation=cv2.INTER_LINEAR)
    canvas = np.full((size, size, 3), 114, dtype=np.uint8)
    canvas[:new_height, :new_width] = resized
    return canvas, ratio, size - new_width, size - new_height


def main() -> None:
    image = cv2.imread(str(IMAGE_PATH), cv2.IMREAD_COLOR)
    if image is None:
        raise RuntimeError(f"Cannot read image: {IMAGE_PATH}")
    # Use a realistic tile instead of the full 690x14875 page to match production processing.
    tile = image[:2400]
    boxed, ratio, dw, dh = letterbox(tile)
    net = cv2.dnn.readNetFromONNX(str(MODEL_PATH))
    blob = cv2.dnn.blobFromImage(boxed, scalefactor=1 / 255.0, size=(1024, 1024), swapRB=True, crop=False)
    net.setInput(blob)
    outputs = net.forward(net.getUnconnectedOutLayersNames())
    print({
        "tile_shape": tile.shape,
        "letterbox_ratio": ratio,
        "padding": [dw, dh],
        "output_names": list(net.getUnconnectedOutLayersNames()),
        "outputs": [{"shape": list(output.shape), "dtype": str(output.dtype), "min": float(np.min(output)), "max": float(np.max(output))} for output in outputs],
    })


if __name__ == "__main__":
    main()
