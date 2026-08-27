import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";
import { requestLocalComicTextDetection } from "../server/standalone/inpainting-client";

const root = "/home/ubuntu/manga-bubble-cleaner-retained-fixtures/drive-result-evaluation";
const sourceDir = join(root, "originals");
const outputDir = join(root, "full-page-detector-overlays", new Date().toISOString().replace(/[:.]/g, "-"));

async function main() {
  await mkdir(outputDir, { recursive: true });
  const report = [];
  for (const name of (await readdir(sourceDir)).filter((item) => /\.(png|jpe?g|webp)$/i.test(item)).sort()) {
    const image = await readFile(join(sourceDir, name));
    const metadata = await sharp(image).metadata();
    const regions = await requestLocalComicTextDetection(image) ?? [];
    const rects = regions.map((region) => `<rect x="${region.x}" y="${region.y}" width="${region.width}" height="${region.height}" fill="none" stroke="#00e5ff" stroke-width="5"/><text x="${region.x}" y="${Math.max(18, region.y - 5)}" fill="#00e5ff" font-size="24">${region.confidence.toFixed(2)}</text>`).join("");
    const overlay = `<svg width="${metadata.width}" height="${metadata.height}" xmlns="http://www.w3.org/2000/svg">${rects}</svg>`;
    await sharp(image).composite([{ input: Buffer.from(overlay) }]).png().toFile(join(outputDir, `${name}.png`));
    report.push({ name, width: metadata.width, height: metadata.height, detections: regions });
  }
  await writeFile(join(outputDir, "regions.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ outputDir, pages: report.map((page) => ({ name: page.name, detectionCount: page.detections.length })) }, null, 2));
}

main().then(() => process.exit(0)).catch((error) => { console.error(error); process.exit(1); });
