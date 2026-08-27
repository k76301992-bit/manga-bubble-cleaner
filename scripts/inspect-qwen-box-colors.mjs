import sharp from "sharp";

const [imagePath] = process.argv.slice(2);
if (!imagePath) throw new Error("Usage: node scripts/inspect-qwen-box-colors.mjs <image-path>");

const width = 900;
const { data } = await sharp(imagePath).extract({ left: 0, top: 7200, width, height: 1200 }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
const box = { left: 318, top: 518, width: 264, height: 60 };
const luminance = (offset) => Math.round(0.2126 * data[offset] + 0.7152 * data[offset + 1] + 0.0722 * data[offset + 2]);
const inBox = [];
const sideSamples = [];
for (let y = box.top; y < box.top + box.height; y += 1) for (let x = box.left; x < box.left + box.width; x += 1) {
  const offset = (y * width + x) * 4;
  inBox.push(luminance(offset));
  if (x < box.left + 8 || x >= box.left + box.width - 8) sideSamples.push(luminance(offset));
}
const percentile = (values, p) => values.sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * p))];
console.log(JSON.stringify({
  box,
  boxLuminance: { min: Math.min(...inBox), p10: percentile(inBox, 0.1), p50: percentile(inBox, 0.5), p90: percentile(inBox, 0.9), max: Math.max(...inBox) },
  sideLuminance: { min: Math.min(...sideSamples), p10: percentile(sideSamples, 0.1), p50: percentile(sideSamples, 0.5), p90: percentile(sideSamples, 0.9), max: Math.max(...sideSamples) },
}, null, 2));
