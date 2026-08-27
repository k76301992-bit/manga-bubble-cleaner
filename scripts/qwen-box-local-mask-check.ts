import sharp from "sharp";

import { hasSmoothBubbleBackdrop, inpaintDetectedTextBoxes } from "../server/manga-bubble-cleaner";

async function main() {
  const [inputPath, outputPath] = process.argv.slice(2);
  if (!inputPath || !outputPath) throw new Error("Usage: tsx scripts/qwen-box-local-mask-check.ts <image-path> <output-path>");
  const width = 900; const tileTop = 7200; const height = 1200;
  const extracted = await sharp(inputPath).extract({ left: 0, top: tileTop, width, height }).ensureAlpha().raw().toBuffer();
  const region = { x: 328, y: 528, width: 244, height: 40 };
  console.log(JSON.stringify({ smoothBackdrop: hasSmoothBubbleBackdrop(extracted, width, height, region), region }));
  const repaired = inpaintDetectedTextBoxes(extracted, width, height, [region]);
  await sharp(repaired, { raw: { width, height, channels: 4 } }).png().toFile(outputPath);
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
