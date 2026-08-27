import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";
import { cleanImageInMemory, type CleaningQuality } from "../server/standalone/cleaner";

const root = process.env.RETAINED_CHAPTER_ROOT || "/home/ubuntu/manga-bubble-cleaner-retained-fixtures/user-chapter";
const sourceDirectory = join(root, "source-pages", "196 [stitched]");
const outputDirectory = join(root, "results");
const quality = (process.argv[2] === "maximum-detail" ? "maximum-detail" : "balanced") as CleaningQuality;
const pageFilter = process.argv[3]?.trim();

async function main() {
  const names = (await readdir(sourceDirectory)).filter((name) => /\.(jpe?g|png|webp)$/i.test(name) && (!pageFilter || name === pageFilter)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  if (!names.length) throw new Error("لم تطابق تصفية الصفحة أي صورة في عينة الفصل.");
  await mkdir(outputDirectory, { recursive: true });
  const pages: Array<Record<string, unknown>> = [];
  for (const [index, name] of names.entries()) {
    const sourcePath = join(sourceDirectory, name);
    const source = await readFile(sourcePath);
    const before = await sharp(source).metadata();
    const startedAt = performance.now();
    const cleaned = await cleanImageInMemory({ image: source, mimeType: "image/jpeg", quality });
    const resultPath = join(outputDirectory, `${name.replace(/\.[^.]+$/, "")}-clean.png`);
    await writeFile(resultPath, cleaned.image);
    const after = await sharp(cleaned.image).metadata();
    pages.push({ page: name, index: index + 1, sourceBytes: (await stat(sourcePath)).size, before: { width: before.width, height: before.height }, after: { width: after.width, height: after.height }, seconds: Number(((performance.now() - startedAt) / 1000).toFixed(3)), dimensionsMatch: before.width === after.width && before.height === after.height, detectedRegions: cleaned.detectedRegions, remoteDetectionTiles: cleaned.remoteDetectionTiles, trainedInpaintRegions: cleaned.trainedInpaintRegions, resultPath });
    console.log(JSON.stringify(pages.at(-1)));
  }
  await writeFile(join(root, `chapter-test-${quality}.json`), `${JSON.stringify({ quality, pages }, null, 2)}\n`);
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
