import sharp from "sharp";

const [beforePath, afterPath, x = "0", y = "0", width, height] = process.argv.slice(2);
if (!beforePath || !afterPath || !width || !height) throw new Error("Usage: node scripts/compare-region.mjs <before> <after> <x> <y> <width> <height>");
const region = { left: Number(x), top: Number(y), width: Number(width), height: Number(height) };
const [before, after] = await Promise.all([
  sharp(beforePath).extract(region).ensureAlpha().raw().toBuffer(),
  sharp(afterPath).extract(region).ensureAlpha().raw().toBuffer(),
]);
let changed = 0;
let totalDistance = 0;
for (let offset = 0; offset < before.length; offset += 4) {
  const distance = Math.abs(before[offset] - after[offset]) + Math.abs(before[offset + 1] - after[offset + 1]) + Math.abs(before[offset + 2] - after[offset + 2]);
  if (distance) changed += 1;
  totalDistance += distance;
}
console.log(JSON.stringify({ region, pixelCount: before.length / 4, changedPixels: changed, changeRate: changed / (before.length / 4), meanChannelDistance: totalDistance / (before.length / 4) }, null, 2));
