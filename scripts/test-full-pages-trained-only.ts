import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import sharp from "sharp";
import { cleanImageInMemory } from "../server/standalone/cleaner";

const root = "/home/ubuntu/manga-bubble-cleaner-retained-fixtures/drive-result-evaluation";
const originalsDir = join(root, "originals");
const outputDir = join(root, "full-page-trained-only", new Date().toISOString().replace(/[:.]/g, "-"));

async function main() {
  await mkdir(outputDir, { recursive: true });
  const names = (await readdir(originalsDir)).filter((name) => /\.(png|jpe?g|webp)$/i.test(name)).sort();
  const pages = [];
  for (const name of names) {
    const image = await readFile(join(originalsDir, name));
    const mimeType = extname(name).toLowerCase() === ".png" ? "image/png" : /\.jpe?g$/i.test(name) ? "image/jpeg" : "image/webp";
    const started = performance.now();
    const result = await cleanImageInMemory({ image, mimeType, quality: "maximum-detail" });
    const seconds = Number(((performance.now() - started) / 1000).toFixed(3));
    const outputName = `${basename(name, extname(name))}-trained-only.png`;
    await writeFile(join(outputDir, outputName), result.image);
    const output = await sharp(result.image).metadata();
    pages.push({ source: name, output: outputName, sourceDimensions: [result.width, result.height], outputDimensions: [output.width, output.height], dimensionsMatch: output.width === result.width && output.height === result.height, seconds, detectedRegions: result.detectedRegions, trainedInpaintRegions: result.trainedInpaintRegions, remoteDetectionTiles: result.remoteDetectionTiles });
  }
  await writeFile(join(outputDir, "summary.json"), JSON.stringify({ mode: "maximum-detail-trained-only", input: "complete original pages", pages }, null, 2));
  console.log(JSON.stringify({ outputDir, pages }, null, 2));
}

main().then(() => process.exit(0)).catch((error) => { console.error(error); process.exit(1); });
