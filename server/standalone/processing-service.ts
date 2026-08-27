import { randomUUID } from "node:crypto";
import sharp, { type Metadata } from "sharp";
import { cleanImageInMemory, type CleaningQuality, type ManualMaskAdjustment } from "./cleaner";
import { createProcessingJob, updateProcessingJob } from "./job-store";

export const supportedImageTypes = new Set(["image/png", "image/jpeg", "image/webp"]);
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
export const MAX_IMAGE_PIXELS = 20_000_000;

let cleaningInProgress = false;

export class ProcessingRequestError extends Error {
  constructor(public readonly statusCode: number, public readonly code: string, message: string, public readonly jobId?: string) {
    super(message);
  }
}

export function cleanOutputFileName(value: string) {
  return value.replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 96) || "manhwa-page";
}

export async function processImageInMemory(input: {
  image: Buffer;
  mimeType: string;
  fileName: string;
  quality: CleaningQuality;
  maskAdjustments?: ManualMaskAdjustment[];
}) {
  if (!supportedImageTypes.has(input.mimeType) || !input.image.length) throw new ProcessingRequestError(400, "invalid-image", "أرسل ملف PNG أو JPG أو WebP صالحًا.");
  if (input.image.length > MAX_IMAGE_BYTES) throw new ProcessingRequestError(413, "image-too-large", "الصورة تتجاوز حد 20 ميغابايت.");
  if (cleaningInProgress) throw new ProcessingRequestError(429, "server-busy", "الخادم يعالج صفحة أخرى الآن؛ أعد المحاولة بعد انتهائها.");

  let metadata: Metadata;
  try { metadata = await sharp(input.image, { animated: false }).metadata(); }
  catch { throw new ProcessingRequestError(422, "unreadable-image", "تعذر قراءة ملف الصورة."); }
  if (!metadata.width || !metadata.height || metadata.width * metadata.height > MAX_IMAGE_PIXELS) throw new ProcessingRequestError(413, "image-dimensions-too-large", "أبعاد الصورة تتجاوز الحد الذاكري الآمن للخادم (20 مليون بكسل).");

  cleaningInProgress = true;
  const id = randomUUID();
  const fileName = cleanOutputFileName(input.fileName);
  await createProcessingJob({ id, fileName, mimeType: input.mimeType });
  try {
    const result = await cleanImageInMemory({
      image: input.image,
      mimeType: input.mimeType,
      quality: input.quality,
      maskAdjustments: input.maskAdjustments,
      onTile: async ({ tileIndex, tileCount, status }) => { await updateProcessingJob(id, { status, completedTiles: tileIndex, tileCount }); },
    });
    await updateProcessingJob(id, { status: "completed", completedTiles: result.tileCount, tileCount: result.tileCount, width: result.width, height: result.height });
    return { jobId: id, fileName, ...result };
  } catch (error) {
    const message = error instanceof Error ? error.message : "تعذرت معالجة الصورة.";
    await updateProcessingJob(id, { status: "failed", error: message });
    throw new ProcessingRequestError(422, "processing-failed", message, id);
  } finally {
    cleaningInProgress = false;
  }
}
