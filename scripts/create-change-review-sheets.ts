import { mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";

const root = process.env.RETAINED_CHAPTER_ROOT || "/home/ubuntu/manga-bubble-cleaner-retained-fixtures/user-chapter";
const cropRoot = join(root, "change-crops");
const outputRoot = join(root, "change-review-sheets");
const cellWidth = 460;
const cellHeight = 190;
const columns = 2;

async function main() {
  await rm(outputRoot, { recursive: true, force: true }); await mkdir(outputRoot, { recursive: true });
  for (const page of (await readdir(cropRoot)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))) {
    const directory = join(cropRoot, page); const files = (await readdir(directory)).filter((name) => name.endsWith(".png")).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    const rows = Math.ceil(files.length / columns);
    const composites = await Promise.all(files.map(async (file, index) => ({ input: await sharp(join(directory, file)).resize({ width: cellWidth - 16, height: cellHeight - 16, fit: "contain", background: "#191919" }).png().toBuffer(), left: (index % columns) * cellWidth + 8, top: Math.floor(index / columns) * cellHeight + 8 })));
    await sharp({ create: { width: cellWidth * columns, height: Math.max(cellHeight, rows * cellHeight), channels: 4, background: "#191919" } }).composite(composites).png().toFile(join(outputRoot, `${page}.png`));
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
