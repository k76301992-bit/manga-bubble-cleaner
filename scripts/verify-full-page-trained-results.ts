import { readdir, readFile, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import sharp from "sharp";
import { hasLikelyClosedBubbleOutline, hasNeutralLightBubbleInterior, hasSmoothBubbleBackdrop, isLikelyQrTextCluster } from "../server/standalone/cleaner";
import { requestLocalComicTextDetectionWithMask } from "../server/standalone/inpainting-client";

const root = "/home/ubuntu/manga-bubble-cleaner-retained-fixtures/drive-result-evaluation";
const originalsDir = join(root, "originals");
const resultsDir = join(root, "full-page-trained-only", process.env.RESULTS_RUN_ID || "2026-08-27T20-49-20-377Z");

function intersects(region: { x: number; y: number; width: number; height: number }, x: number, y: number, padding = 132) {
  return x >= region.x - padding && x < region.x + region.width + padding && y >= region.y - padding && y < region.y + region.height + padding;
}

function overlaps(a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; width: number; height: number }) {
  const area = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  return area / Math.max(1, Math.min(a.width * a.height, b.width * b.height)) >= 0.35;
}

function maskCoverage(mask: Buffer | undefined, width: number, region: { x: number; y: number; width: number; height: number }) {
  if (!mask?.length) return undefined;
  let covered = 0;
  for (let y = region.y; y < region.y + region.height; y += 1) for (let x = region.x; x < region.x + region.width; x += 1) if (mask[y * width + x] > 0) covered += 1;
  return covered / Math.max(1, region.width * region.height);
}

async function main() {
  const pages = [];
  for (const name of (await readdir(originalsDir)).filter((item) => /\.(png|jpe?g|webp)$/i.test(item)).sort()) {
    const outputName = `${basename(name, extname(name))}-trained-only.png`;
    const [original, result] = await Promise.all([readFile(join(originalsDir, name)), readFile(join(resultsDir, outputName))]);
    const originalRaw = await sharp(original).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const resultRaw = await sharp(result).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const beforeDetection = await requestLocalComicTextDetectionWithMask(original);
    const before = beforeDetection?.regions ?? [];
    // This is a full-page JPEG representation for the detector only; the inspected input and output remain the full-resolution pages.
    const resultForDetection = await sharp(result).jpeg({ quality: 88, chromaSubsampling: "4:4:4" }).toBuffer();
    const afterDetection = await requestLocalComicTextDetectionWithMask(resultForDetection);
    const after = afterDetection?.regions ?? [];
    const accepted = before.filter((region) => !isLikelyQrTextCluster(region) && hasLikelyClosedBubbleOutline(originalRaw.data, originalRaw.info.width, originalRaw.info.height, region) && (hasNeutralLightBubbleInterior(originalRaw.data, originalRaw.info.width, originalRaw.info.height, region) || hasSmoothBubbleBackdrop(originalRaw.data, originalRaw.info.width, originalRaw.info.height, region)));
    let changed = 0; let changedOutsideAcceptedAreas = 0;
    for (let pixel = 0; pixel < originalRaw.info.width * originalRaw.info.height; pixel += 1) {
      const offset = pixel * 4;
      if (originalRaw.data[offset] === resultRaw.data[offset] && originalRaw.data[offset + 1] === resultRaw.data[offset + 1] && originalRaw.data[offset + 2] === resultRaw.data[offset + 2]) continue;
      changed += 1;
      const x = pixel % originalRaw.info.width; const y = Math.floor(pixel / originalRaw.info.width);
      if (!accepted.some((region) => intersects(region, x, y))) changedOutsideAcceptedAreas += 1;
    }
    const overlappingDetectorBoxesAfter = accepted.filter((region) => after.some((candidate) => overlaps(region, candidate)));
    const coverage = accepted.map((region) => ({ region, before: maskCoverage(beforeDetection?.textMask, originalRaw.info.width, region), after: maskCoverage(afterDetection?.textMask, originalRaw.info.width, region) }));
    const remainingLikelyTextRegions = coverage.filter((item) => item.after !== undefined && item.after >= 0.08 && (item.before === undefined || item.after >= item.before * 0.28));
    pages.push({ name, dimensions: [originalRaw.info.width, originalRaw.info.height], detectedBefore: before.length, acceptedForTrainedRepair: accepted.length, overlappingDetectorBoxesAfter: overlappingDetectorBoxesAfter.length, remainingLikelyTextRegions, maskCoverage: coverage, changedPixels: changed, changedPixelsOutsideAcceptedAreas: changedOutsideAcceptedAreas });
  }
  const destination = join(resultsDir, "full-page-verification.json");
  await writeFile(destination, JSON.stringify({ input: "complete pages", mode: "trained-only", pages }, null, 2));
  console.log(JSON.stringify({ destination, pages }, null, 2));
}

main().then(() => process.exit(0)).catch((error) => { console.error(error); process.exit(1); });
