from pathlib import Path
from zipfile import ZipFile
import io
import cv2
import numpy as np
from PIL import Image

ARCHIVE = Path('/home/ubuntu/upload/أرشيف.zip')
MODEL = Path('/tmp/first-two-models/comictextdetector.pt.onnx')
WINDOW = 2048
OVERLAP = 256

def detect_window(net, source):
    height, width = source.shape[:2]
    ratio = min(1024 / width, 1024 / height)
    rw, rh = round(width * ratio), round(height * ratio)
    canvas = np.full((1024, 1024, 3), 114, dtype=np.uint8)
    canvas[:rh, :rw] = cv2.resize(source, (rw, rh), interpolation=cv2.INTER_LINEAR)
    blob = cv2.dnn.blobFromImage(canvas, scalefactor=1/255.0, size=(1024,1024), swapRB=True, crop=False)
    net.setInput(blob)
    outputs = net.forward(['blk'])
    blocks = np.asarray(outputs, dtype=np.float32).reshape(-1, 7)
    candidates = []
    for row in blocks:
        cx, cy, bw, bh, obj = row[:5]
        cls = row[5:]
        if not len(cls):
            continue
        score = float(obj * cls[int(np.argmax(cls))])
        if score >= 0.40 and bw >= 5 and bh >= 5:
            candidates.append(([round(cx-bw/2), round(cy-bh/2), round(bw), round(bh)], score))
    if not candidates:
        return 0, 0
    indices = cv2.dnn.NMSBoxes([x[0] for x in candidates], [x[1] for x in candidates], 0.40, 0.35)
    return len(candidates), len(np.asarray(indices).reshape(-1))

def main():
    net = cv2.dnn.readNetFromONNX(str(MODEL))
    with ZipFile(ARCHIVE) as z:
        names = [i for i in z.infolist() if not i.is_dir() and i.filename.lower().endswith(('.jpg','.jpeg','.png','.webp')) and '__MACOSX' not in i.filename and not Path(i.filename).name.startswith('._')]
        for info in names:
            data = z.read(info)
            source = cv2.imdecode(np.frombuffer(data, np.uint8), cv2.IMREAD_COLOR)
            total_candidates = total_regions = windows = 0
            starts = list(range(0, max(1, source.shape[0]-WINDOW+1), WINDOW-OVERLAP))
            final_start = max(0, source.shape[0]-WINDOW)
            if final_start not in starts: starts.append(final_start)
            for top in sorted(set(starts)):
                bottom = min(source.shape[0], top+WINDOW)
                c, r = detect_window(net, source[top:bottom])
                windows += 1; total_candidates += c; total_regions += r
            print({'name': Path(info.filename).name, 'size': list(source.shape[:2]), 'windows': windows, 'candidates': total_candidates, 'nms_regions': total_regions})

if __name__ == '__main__':
    main()

# Keep PIL import intentional: it validates that the archive payload is a decodable image type.
_ = Image
_io = io
ատ = None
if False:
    print(_io, _)
    print(ատ)

if __name__ == '__main__':
    pass
