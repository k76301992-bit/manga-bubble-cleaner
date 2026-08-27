import cv2
import numpy as np
from pathlib import Path


def main() -> None:
    net = cv2.dnn.readNetFromONNX("server/inference-service/models/comictextdetector.pt.onnx")
    image = cv2.imread(str(Path("/home/ubuntu/manga-bubble-cleaner-retained-fixtures/drive-result-evaluation/originals/IMG_7542.webp")))
    window_top, window = 408, image[408:2456]
    canvas = cv2.resize(window, (400, 1024), interpolation=cv2.INTER_AREA)
    padded = cv2.copyMakeBorder(canvas, 0, 0, 0, 624, cv2.BORDER_CONSTANT, value=(114, 114, 114))
    blob = cv2.dnn.blobFromImage(padded, scalefactor=1 / 255.0, size=(1024, 1024), swapRB=True, crop=False)
    net.setInput(blob)
    outputs = net.forward(["blk", "det", "seg"])
    target = (slice(round((2180 - window_top) * 0.5), round((2180 - window_top + 222) * 0.5)), slice(round(216 * 0.5), round((216 + 286) * 0.5)))
    print({
        "outputs": net.getUnconnectedOutLayersNames(),
        "shapes": {name: list(value.shape) for name, value in zip(["blk", "det", "seg"], outputs)},
        "ranges": {name: [float(value.min()), float(value.max())] for name, value in zip(["blk", "det", "seg"], outputs)},
        "targetThresholdCoverage": {
            "det0": float(np.mean(outputs[1][0, 0][target] >= 0.30)),
            "det1": float(np.mean(outputs[1][0, 1][target] >= 0.30)),
            "seg": float(np.mean(outputs[2][0, 0][target] >= 0.30)),
        },
    })


if __name__ == "__main__":
    main()
