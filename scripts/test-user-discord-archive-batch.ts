import { readFile } from "node:fs/promises";
import sharp from "sharp";
import { cleanBatchInMemory, extractImagesFromZip } from "../server/standalone/batch-processing";

async function main() {
  const archive = await readFile("/home/ubuntu/upload/أرشيف.zip");
  const images = await extractImagesFromZip(archive);
  const started = performance.now();
  const results = await cleanBatchInMemory({ images, quality: "maximum-detail" });
  const pages = await Promise.all(results.map(async (result, index) => {
    const source = await sharp(images[index].image).metadata(); const output = await sharp(result.image).metadata();
    return { name: result.sourceName, source: [source.width, source.height], output: [output.width, output.height], dimensionsMatch: source.width === output.width && source.height === output.height };
  }));
  console.log(JSON.stringify({ inputPages: images.length, outputPages: results.length, seconds: Number(((performance.now() - started) / 1000).toFixed(3)), pages }, null, 2));
}

main().then(() => process.exit(0)).catch((error) => { console.error(error); process.exit(1); });
