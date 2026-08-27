import { readFile } from "node:fs/promises";
import { cleanImageInMemory } from "../server/standalone/cleaner";

async function main() {
  try {
    const image = await readFile(process.argv[2]);
    const result = await cleanImageInMemory({ image, mimeType: "image/png", quality: "preserve-detail" });
    console.log(JSON.stringify({ ok: true, width: result.width, height: result.height, tileCount: result.tileCount, detectedRegions: result.detectedRegions }));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}

void main();
