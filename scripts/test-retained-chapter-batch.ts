import { readFile, writeFile } from "node:fs/promises";
import sharp from "sharp";
import { cleanBatchInMemory, createResultZip, extractImagesFromZip } from "../server/standalone/batch-processing";

const root = process.env.RETAINED_CHAPTER_ROOT || "/home/ubuntu/manga-bubble-cleaner-retained-fixtures/user-chapter";

async function main() {
  const input = await readFile(`${root}/196-stitched-chapter.zip`);
  const images = await extractImagesFromZip(input);
  const started = performance.now();
  const results = await cleanBatchInMemory({ images, quality: "maximum-detail" });
  const output = await createResultZip(results);
  const dimensions = await Promise.all(results.map(async (result, index) => {
    const source = await sharp(images[index].image).metadata(); const cleaned = await sharp(result.image).metadata();
    return { name: result.sourceName, source: [source.width, source.height], output: [cleaned.width, cleaned.height], dimensionsMatch: source.width === cleaned.width && source.height === cleaned.height };
  }));
  const report = { inputImages: images.length, outputImages: results.length, seconds: Number(((performance.now() - started) / 1000).toFixed(3)), resultZipBytes: output.length, dimensions };
  await writeFile(`${root}/batch-test-report.json`, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
