import fs from "node:fs/promises";
import sharp from "sharp";

import { inpaintDetectedTextBoxes } from "../server/manga-bubble-cleaner";

async function main() {
  const [inputPath, outputPath] = process.argv.slice(2);
  if (!inputPath || !outputPath) throw new Error("Usage: tsx scripts/direct-mask-retest.ts <input-image> <output-image>");

  const image = sharp(inputPath).ensureAlpha();
  const metadata = await image.metadata();
  if (!metadata.width || !metadata.height) throw new Error("Image has no dimensions");

  const source = await image.raw().toBuffer();
  const regions = [
    // "YOUNGEST." — text, white highlight, dark fill and drop-shadow inside the pink gradient bubble.
    { x: 306, y: 7688, width: 304, height: 120 },
    // "ZIPPLE'S MANA BOMB." — white lettering with a dark-red shadow inside the caption box.
    { x: 292, y: 14615, width: 352, height: 178 },
    // Known dark oval reference — validates that the same direct route preserves its border and tail.
    { x: 276, y: 10850, width: 349, height: 173 },
  ];

  const repaired = inpaintDetectedTextBoxes(source, metadata.width, metadata.height, regions);
  await sharp(repaired, { raw: { width: metadata.width, height: metadata.height, channels: 4 } }).png().toFile(outputPath);
  await fs.writeFile(`${outputPath}.json`, JSON.stringify({ inputPath, outputPath, width: metadata.width, height: metadata.height, regions }, null, 2));
  console.log(JSON.stringify({ width: metadata.width, height: metadata.height, regions, outputPath }, null, 2));
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
