from pathlib import Path
import numpy as np
from PIL import Image


ROOT = Path("/home/ubuntu/manga-bubble-cleaner-retained-fixtures/drive-result-evaluation")
SEGMENTATION = ROOT / "full-page-text-segmentation" / "2026-08-27T20-45-57"
REGIONS = {
    "IMG_7542.webp": [(92, 190, 188, 180, "واجهة QR"), (216, 2180, 284, 220, "فقاعة حوار متبقية")],
    "IMG_7546.jpeg": [(418, 5878, 204, 122, "فقاعة متبقية 1"), (290, 9560, 334, 160, "فقاعة متبقية 2")],
}


def main() -> None:
    for name, regions in REGIONS.items():
        pixels = np.asarray(Image.open(ROOT / "originals" / name).convert("RGB"))
        mask = np.asarray(Image.open(SEGMENTATION / f"{name}.mask.png").convert("L"))
        for x, y, width, height, label in regions:
            area = pixels[y:y + height, x:x + width]
            luma = area[:, :, 0] * 0.299 + area[:, :, 1] * 0.587 + area[:, :, 2] * 0.114
            print({
                "page": name,
                "label": label,
                "box": [x, y, width, height],
                "darkRatio": round(float(np.mean(luma < 105)), 3),
                "veryDarkRatio": round(float(np.mean(luma < 55)), 3),
                "segmentRatio": round(float(np.mean(mask[y:y + height, x:x + width] > 0)), 3),
            })


if __name__ == "__main__":
    main()
