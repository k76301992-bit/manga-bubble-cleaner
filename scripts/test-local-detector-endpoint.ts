import { readFile } from "node:fs/promises";
import sharp from "sharp";

async function main() {
  const root = process.env.RETAINED_CHAPTER_ROOT || "/home/ubuntu/manga-bubble-cleaner-retained-fixtures/user-chapter";
  const source = await readFile(`${root}/source-pages/196 [stitched]/01.jpg`);
  const tile = await sharp(source).extract({ left: 0, top: 4800, width: 690, height: 2400 }).jpeg({ quality: 92, chromaSubsampling: "4:4:4" }).toBuffer();
  const started = performance.now();
  const response = await fetch("http://127.0.0.1:8090/v1/detect-text", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ image: tile.toString("base64") }),
  });
  const payload = await response.json() as { regions?: unknown[]; elapsedMs?: unknown; detail?: string };
  console.log(JSON.stringify({ status: response.status, boxes: Array.isArray(payload.regions) ? payload.regions.length : 0, serviceMs: payload.elapsedMs, wallMs: Math.round(performance.now() - started), detail: payload.detail }, null, 2));
  if (!response.ok) process.exitCode = 1;
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
