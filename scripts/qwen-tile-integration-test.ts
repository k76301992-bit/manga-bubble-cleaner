import fs from "node:fs/promises";

import { cleanMangaTile, storeMangaSource } from "../server/manga-bubble-cleaner";

async function main() {
  const [imagePath, outputPath] = process.argv.slice(2);
  if (!imagePath || !outputPath) throw new Error("Usage: tsx scripts/qwen-tile-integration-test.ts <image-path> <output-json>");
  const tileIndex = Number(process.env.QWEN_TEST_TILE_INDEX ?? 6);
  if (!Number.isInteger(tileIndex) || tileIndex < 0) throw new Error("QWEN_TEST_TILE_INDEX must be a non-negative integer.");

  const image = await fs.readFile(imagePath);
  const source = await storeMangaSource(`data:image/webp;base64,${image.toString("base64")}`, "qwen-integration-sample.webp");
  const result = await cleanMangaTile({
    sourceKey: source.sourceKey,
    fileName: "qwen-integration-sample.webp",
    quality: "maximum-detail",
    width: 900,
    height: 16000,
    tileIndex,
  });
  await fs.writeFile(outputPath, JSON.stringify({ source, result }, null, 2));
  console.log(JSON.stringify({ source, result }, null, 2));
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
