import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";

const root = process.env.RETAINED_CHAPTER_ROOT || "/home/ubuntu/manga-bubble-cleaner-retained-fixtures/user-chapter";
const sourceDirectory = join(root, "source-pages", "196 [stitched]");
const resultDirectory = join(root, "results");
const reviewDirectory = join(root, "change-crops");

type Box = { x: number; y: number; width: number; height: number; pixels: number };
const clamp = (value: number, minimum: number, maximum: number) => Math.max(minimum, Math.min(maximum, value));

function mergeNearby(boxes: Box[]) {
  const groups: Box[] = [];
  for (const box of boxes.sort((a, b) => a.y - b.y || a.x - b.x)) {
    const group = groups.find((candidate) => {
      const horizontalGap = Math.max(0, Math.max(candidate.x, box.x) - Math.min(candidate.x + candidate.width, box.x + box.width));
      const verticalGap = Math.max(0, Math.max(candidate.y, box.y) - Math.min(candidate.y + candidate.height, box.y + box.height));
      return horizontalGap <= 42 && verticalGap <= 32;
    });
    if (!group) groups.push({ ...box });
    else {
      const right = Math.max(group.x + group.width, box.x + box.width); const bottom = Math.max(group.y + group.height, box.y + box.height);
      group.x = Math.min(group.x, box.x); group.y = Math.min(group.y, box.y); group.width = right - group.x; group.height = bottom - group.y; group.pixels += box.pixels;
    }
  }
  return groups;
}

async function main() {
  await rm(reviewDirectory, { recursive: true, force: true });
  await mkdir(reviewDirectory, { recursive: true });
  const pages: Array<{ page: string; changedBoxes: Box[] }> = [];
  const names = (await readdir(sourceDirectory)).filter((name) => /\.jpe?g$/i.test(name)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  for (const name of names) {
    const resultName = `${name.replace(/\.[^.]+$/, "")}-clean.png`;
    const sourcePath = join(sourceDirectory, name); const resultPath = join(resultDirectory, resultName);
    const source = await sharp(await readFile(sourcePath)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const result = await sharp(await readFile(resultPath)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    if (source.info.width !== result.info.width || source.info.height !== result.info.height) throw new Error(`الأبعاد غير متطابقة: ${name}`);
    const pixelCount = source.info.width * source.info.height; const changed = new Uint8Array(pixelCount); const visited = new Uint8Array(pixelCount);
    for (let index = 0; index < pixelCount; index += 1) {
      const offset = index * 4;
      const difference = Math.abs(source.data[offset] - result.data[offset]) + Math.abs(source.data[offset + 1] - result.data[offset + 1]) + Math.abs(source.data[offset + 2] - result.data[offset + 2]);
      if (difference > 24) changed[index] = 1;
    }
    const boxes: Box[] = [];
    for (let start = 0; start < pixelCount; start += 1) {
      if (!changed[start] || visited[start]) continue;
      const stack = [start]; visited[start] = 1; let pixels = 0; let minX = source.info.width; let maxX = 0; let minY = source.info.height; let maxY = 0;
      while (stack.length) {
        const index = stack.pop()!; const x = index % source.info.width; const y = Math.floor(index / source.info.width); pixels += 1; minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
        for (let dy = -1; dy <= 1; dy += 1) for (let dx = -1; dx <= 1; dx += 1) {
          const nx = x + dx; const ny = y + dy; const next = ny * source.info.width + nx;
          if (nx >= 0 && nx < source.info.width && ny >= 0 && ny < source.info.height && changed[next] && !visited[next]) { visited[next] = 1; stack.push(next); }
        }
      }
      if (pixels >= 8) boxes.push({ x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1, pixels });
    }
    const changedBoxes = mergeNearby(boxes).filter((box) => box.width >= 3 && box.height >= 3);
    const pageDirectory = join(reviewDirectory, name.replace(/\.[^.]+$/, "")); await mkdir(pageDirectory, { recursive: true });
    for (const [index, box] of changedBoxes.entries()) {
      const left = clamp(box.x - 32, 0, source.info.width - 1); const top = clamp(box.y - 32, 0, source.info.height - 1);
      const right = clamp(box.x + box.width + 32, left + 1, source.info.width); const bottom = clamp(box.y + box.height + 32, top + 1, source.info.height);
      const width = right - left; const height = bottom - top;
      await sharp({ create: { width: width * 2, height, channels: 4, background: "#161616" } }).composite([
        { input: await sharp(sourcePath).extract({ left, top, width, height }).png().toBuffer(), left: 0, top: 0 },
        { input: await sharp(resultPath).extract({ left, top, width, height }).png().toBuffer(), left: width, top: 0 },
      ]).png().toFile(join(pageDirectory, `${String(index + 1).padStart(2, "0")}.png`));
    }
    pages.push({ page: name, changedBoxes });
    console.log(JSON.stringify({ page: name, changedAreas: changedBoxes.length }));
  }
  await writeFile(join(root, "chapter-change-review.json"), `${JSON.stringify({ pages }, null, 2)}\n`);
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
