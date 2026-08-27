import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";

const root = process.env.RETAINED_CHAPTER_ROOT || "/home/ubuntu/manga-bubble-cleaner-retained-fixtures/user-chapter";
const sourceDirectory = join(root, "source-pages", "196 [stitched]");
const resultDirectory = join(root, "results");
const comparisonDirectory = join(root, "comparisons");
const tileHeight = 1600;

async function main() {
  await rm(comparisonDirectory, { recursive: true, force: true });
  await mkdir(comparisonDirectory, { recursive: true });
  const manifest: Array<{ page: string; width: number; height: number; tiles: string[] }> = [];
  const names = (await readdir(sourceDirectory)).filter((name) => /\.jpe?g$/i.test(name)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  for (const name of names) {
    const resultName = `${name.replace(/\.[^.]+$/, "")}-clean.png`;
    const sourceMeta = await sharp(join(sourceDirectory, name)).metadata();
    const resultMeta = await sharp(join(resultDirectory, resultName)).metadata();
    if (!sourceMeta.width || !sourceMeta.height || sourceMeta.width !== resultMeta.width || sourceMeta.height !== resultMeta.height) throw new Error(`أبعاد غير متطابقة في ${name}`);
    const pageDirectory = join(comparisonDirectory, name.replace(/\.[^.]+$/, ""));
    await mkdir(pageDirectory, { recursive: true });
    const tiles: string[] = [];
    for (let top = 0, index = 1; top < sourceMeta.height; top += tileHeight, index += 1) {
      const height = Math.min(tileHeight, sourceMeta.height - top);
      const outName = `${String(index).padStart(2, "0")}.png`;
      await sharp({ create: { width: sourceMeta.width * 2, height, channels: 4, background: "#161616" } })
        .composite([
          { input: await sharp(join(sourceDirectory, name)).extract({ left: 0, top, width: sourceMeta.width, height }).png().toBuffer(), left: 0, top: 0 },
          { input: await sharp(join(resultDirectory, resultName)).extract({ left: 0, top, width: sourceMeta.width, height }).png().toBuffer(), left: sourceMeta.width, top: 0 },
        ])
        .png()
        .toFile(join(pageDirectory, outName));
      tiles.push(join(name.replace(/\.[^.]+$/, ""), outName));
    }
    manifest.push({ page: name, width: sourceMeta.width, height: sourceMeta.height, tiles });
  }
  await writeFile(join(comparisonDirectory, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
