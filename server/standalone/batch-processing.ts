import { basename, extname, parse } from "node:path";
import JSZip from "jszip";
import { type CleaningQuality } from "./cleaner";
import { MAX_IMAGE_BYTES, processImageInMemory, supportedImageTypes } from "./processing-service";

export type BatchImage = { name: string; mimeType: string; image: Buffer };
export type CleanedBatchImage = { sourceName: string; outputName: string; image: Buffer };
export const MAX_IMAGES_PER_BATCH = 10;
export const MAX_ZIP_BYTES = 25 * 1024 * 1024;
const MAX_UNCOMPRESSED_ZIP_BYTES = 100 * 1024 * 1024;

function releaseUnusedPageBuffers() {
  const collect = (globalThis as typeof globalThis & { gc?: () => void }).gc;
  if (typeof collect === "function") collect();
}

export function mimeTypeForFileName(value: string) {
  const extension = extname(value).toLowerCase();
  return extension === ".png" ? "image/png" : extension === ".jpg" || extension === ".jpeg" ? "image/jpeg" : extension === ".webp" ? "image/webp" : undefined;
}

export function naturalNameCompare(a: string, b: string) {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
}

export function outputNameForSource(value: string) {
  const stem = parse(basename(value)).name.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "manhwa-page";
  return `${stem}-clean.png`;
}

export function validateBatchImages(images: BatchImage[]) {
  if (!images.length) throw new Error("لم يُعثر على أي صورة صالحة للمعالجة.");
  if (images.length > MAX_IMAGES_PER_BATCH) throw new Error(`الحد الأقصى هو ${MAX_IMAGES_PER_BATCH} صور في العملية الواحدة.`);
  let total = 0;
  for (const item of images) {
    if (!supportedImageTypes.has(item.mimeType)) throw new Error(`نوع الصورة غير مدعوم: ${item.name}`);
    if (!item.image.length || item.image.length > MAX_IMAGE_BYTES) throw new Error(`الصورة ${item.name} تتجاوز حد 20 ميغابايت.`);
    total += item.image.length;
  }
  if (total > 30 * 1024 * 1024) throw new Error("إجمالي الصور يتجاوز حد الذاكرة الآمن للعملية الواحدة (30 ميغابايت).");
}

export async function extractImagesFromZip(zipBuffer: Buffer): Promise<BatchImage[]> {
  if (!zipBuffer.length || zipBuffer.length > MAX_ZIP_BYTES) throw new Error("ملف ZIP يتجاوز حد 25 ميغابايت.");
  const archive = await JSZip.loadAsync(zipBuffer, { checkCRC32: false, createFolders: false });
  const entries = Object.values(archive.files).filter((entry) => !entry.dir && mimeTypeForFileName(entry.name));
  if (!entries.length) throw new Error("لا يحتوي ZIP على صور PNG أو JPG أو WebP.");
  if (entries.length > MAX_IMAGES_PER_BATCH) throw new Error(`يحتوي ZIP على أكثر من ${MAX_IMAGES_PER_BATCH} صور.`);
  const declaredBytes = entries.reduce((total, entry) => total + Number((entry as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize ?? 0), 0);
  if (declaredBytes > MAX_UNCOMPRESSED_ZIP_BYTES) throw new Error("حجم فك ضغط ZIP يتجاوز الحد الذاكري الآمن.");
  const images: BatchImage[] = [];
  for (const entry of entries.sort((a, b) => naturalNameCompare(a.name, b.name))) {
    const image = await entry.async("nodebuffer");
    const name = basename(entry.name);
    const mimeType = mimeTypeForFileName(name);
    if (!mimeType) continue;
    images.push({ name, mimeType, image });
  }
  validateBatchImages(images);
  return images;
}

export async function cleanBatchInMemory(input: { images: BatchImage[]; quality: CleaningQuality; onProgress?: (current: number, total: number, name: string) => Promise<void> | void }) {
  const images = [...input.images].sort((a, b) => naturalNameCompare(a.name, b.name));
  validateBatchImages(images);
  const results: CleanedBatchImage[] = [];
  for (let index = 0; index < images.length; index += 1) {
    const source = images[index];
    await input.onProgress?.(index, images.length, source.name);
    const result = await processImageInMemory({ image: source.image, mimeType: source.mimeType, fileName: source.name, quality: input.quality });
    results.push({ sourceName: source.name, outputName: outputNameForSource(source.name), image: result.image });
    releaseUnusedPageBuffers();
    await input.onProgress?.(index + 1, images.length, source.name);
  }
  return results;
}

export async function createResultZip(results: CleanedBatchImage[]) {
  const zip = new JSZip();
  for (const result of results) zip.file(result.outputName, result.image, { compression: "DEFLATE", compressionOptions: { level: 6 } });
  return Buffer.from(await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 6 } }));
}
