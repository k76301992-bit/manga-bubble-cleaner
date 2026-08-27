import { readFile, writeFile, mkdir } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { cleanBatchInMemory, createResultZip, extractImagesFromZip } from "../server/standalone/batch-processing";

const archivePath = "/home/ubuntu/upload/196[stitched]-20260827T104949Z-1-001.zip";
const resultDirectory = "/home/ubuntu/manga-bubble-cleaner/tmp/user-zip-hybrid";

async function main() {
  const source = await extractImagesFromZip(await readFile(archivePath));
  const started = performance.now();
  const results = await cleanBatchInMemory({
    images: source,
    quality: "maximum-detail",
    onProgress: (current, total, name) => console.log(JSON.stringify({ current, total, name })),
  });
  const archive = await createResultZip(results);
  const elapsedMs = Math.round(performance.now() - started);
  await mkdir(resultDirectory, { recursive: true });
  await writeFile(`${resultDirectory}/metrics.json`, JSON.stringify({ sourcePages: source.length, resultPages: results.length, elapsedMs, averagePageMs: Math.round(elapsedMs / results.length), resultZipBytes: archive.length }, null, 2));
  console.log(JSON.stringify({ sourcePages: source.length, resultPages: results.length, elapsedMs, averagePageMs: Math.round(elapsedMs / results.length), resultZipBytes: archive.length }));
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
