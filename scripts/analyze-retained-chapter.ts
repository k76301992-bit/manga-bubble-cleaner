import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";
import { detectFallbackDarkTextRegions, type BubbleTextRegion } from "../server/standalone/cleaner";

const root = process.env.RETAINED_CHAPTER_ROOT || "/home/ubuntu/manga-bubble-cleaner-retained-fixtures/user-chapter";
const sourceDirectory = join(root, "source-pages", "196 [stitched]");
const resultDirectory = join(root, "results");
const reviewDirectory = join(root, "review-crops");

function overlap(a: BubbleTextRegion, b: BubbleTextRegion) {
  const width = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
  const height = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  return (width * height) / Math.max(1, Math.min(a.width * a.height, b.width * b.height));
}

function darkFraction(data: Buffer, width: number, region: BubbleTextRegion) {
  let dark = 0;
  for (let y = region.y; y < region.y + region.height; y += 1) for (let x = region.x; x < region.x + region.width; x += 1) {
    const offset = (y * width + x) * 4;
    if ((data[offset] * 0.299) + (data[offset + 1] * 0.587) + (data[offset + 2] * 0.114) < 145) dark += 1;
  }
  return dark / Math.max(1, region.width * region.height);
}

async function main() {
  await rm(reviewDirectory, { recursive: true, force: true });
  await mkdir(reviewDirectory, { recursive: true });
  const pages: Array<Record<string, unknown>> = [];
  const names = (await readdir(sourceDirectory)).filter((name) => /\.jpe?g$/i.test(name)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  for (const name of names) {
    const resultName = `${name.replace(/\.[^.]+$/, "")}-clean.png`;
    const sourceImage = await readFile(join(sourceDirectory, name));
    const resultImage = await readFile(join(resultDirectory, resultName));
    const sourceRaw = await sharp(sourceImage).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const resultRaw = await sharp(resultImage).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const sourceRegions = await detectFallbackDarkTextRegions(sourceImage, sourceRaw.info.width, sourceRaw.info.height, true, 48);
    const resultRegions = await detectFallbackDarkTextRegions(resultImage, resultRaw.info.width, resultRaw.info.height, true, 48);
    const suspected = sourceRegions.flatMap((region) => {
      const before = darkFraction(sourceRaw.data, sourceRaw.info.width, region);
      const after = darkFraction(resultRaw.data, resultRaw.info.width, region);
      const surviving = resultRegions.some((candidate) => overlap(region, candidate) > 0.45);
      return before >= 0.06 && after >= before * 0.45 && surviving ? [{ region, beforeDarkFraction: before, afterDarkFraction: after }] : [];
    });
    const pageDirectory = join(reviewDirectory, name.replace(/\.[^.]+$/, ""));
    await mkdir(pageDirectory, { recursive: true });
    for (const [index, item] of suspected.entries()) {
      const padding = 32;
      const left = Math.max(0, item.region.x - padding); const top = Math.max(0, item.region.y - padding);
      const right = Math.min(sourceRaw.info.width, item.region.x + item.region.width + padding); const bottom = Math.min(sourceRaw.info.height, item.region.y + item.region.height + padding);
      const width = right - left; const height = bottom - top;
      await sharp({ create: { width: width * 2, height, channels: 4, background: "#161616" } }).composite([
        { input: await sharp(sourceImage).extract({ left, top, width, height }).png().toBuffer(), left: 0, top: 0 },
        { input: await sharp(resultImage).extract({ left, top, width, height }).png().toBuffer(), left: width, top: 0 },
      ]).png().toFile(join(pageDirectory, `${String(index + 1).padStart(2, "0")}.png`));
    }
    const entry = { page: name, sourceRegionCount: sourceRegions.length, resultRegionCount: resultRegions.length, suspectedUnremoved: suspected };
    pages.push(entry);
    console.log(JSON.stringify({ page: name, sourceRegions: sourceRegions.length, suspected: suspected.length }));
  }
  await writeFile(join(root, "chapter-review-suspects.json"), `${JSON.stringify({ pages }, null, 2)}\n`);
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
