import { readFile } from "node:fs/promises";
import sharp from "sharp";
import { extractImagesFromZip } from "../server/standalone/batch-processing";

async function main() {
  const archive = await readFile("/home/ubuntu/upload/أرشيف.zip");
  const images = await extractImagesFromZip(archive);
  const pages = await Promise.all(images.map(async (image) => {
    const metadata = await sharp(image.image, { failOn: "warning" }).metadata();
    return { name: image.name, mimeType: image.mimeType, bytes: image.image.length, width: metadata.width, height: metadata.height, format: metadata.format };
  }));
  console.log(JSON.stringify({ zipBytes: archive.length, images: pages }, null, 2));
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
