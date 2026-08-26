import sharp from "sharp";

const [input, output, top = "9600", height = "2400"] = process.argv.slice(2);
if (!input || !output) throw new Error("Usage: node scripts/crop-image.mjs <input> <output> [top] [height]");
const meta = await sharp(input).metadata();
await sharp(input)
  .extract({ left: 0, top: Number(top), width: meta.width, height: Number(height) })
  .png()
  .toFile(output);
