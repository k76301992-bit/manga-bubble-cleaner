import { generateImage } from "./_core/imageGeneration";
import { storageGetSignedUrl, storagePut } from "./storage";
import sharp from "sharp";

export type CleaningQuality = "balanced" | "preserve-detail" | "maximum-detail";

const MAX_INPUT_BYTES = 20 * 1024 * 1024;
const SUPPORTED_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

export function ensurePublicImageUrl(value: string) {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("الرابط غير صالح."); }
  const host = url.hostname.toLowerCase();
  if (!["http:", "https:"].includes(url.protocol) || host === "localhost" || host.endsWith(".local") || /^127\.|^10\.|^192\.168\.|^172\.(1[6-9]|2\d|3[0-1])\./.test(host)) throw new Error("يجب أن يكون الرابط عامًا وآمنًا.");
  return url;
}

export async function importImageFromUrl(value: string) {
  const url = ensurePublicImageUrl(value);
  const response = await fetch(url, { signal: AbortSignal.timeout(15_000), redirect: "follow" });
  if (!response.ok) throw new Error("تعذر تنزيل الصورة من الرابط.");
  const mimeType = (response.headers.get("content-type") ?? "").split(";")[0].toLowerCase();
  if (!SUPPORTED_IMAGE_TYPES.has(mimeType)) throw new Error("يجب أن يقود الرابط إلى صورة PNG أو JPG أو WebP مباشرة.");
  const size = Number(response.headers.get("content-length") ?? 0);
  if (size > MAX_INPUT_BYTES) throw new Error("الصورة في الرابط أكبر من 20 ميغابايت.");
  const buffer = Buffer.from(await response.arrayBuffer());
  if (!buffer.length || buffer.length > MAX_INPUT_BYTES) throw new Error("الصورة في الرابط غير صالحة أو أكبر من الحد المسموح.");
  const meta = await sharp(buffer).metadata();
  if (!meta.width || !meta.height) throw new Error("تعذر قراءة أبعاد الصورة من الرابط.");
  const fileName = decodeURIComponent(url.pathname.split("/").pop() || "linked-manhwa-page.png").replace(/[^a-zA-Z0-9._-]/g, "-");
  const stored = await storagePut(`manga-bubble-cleaner/imports/${Date.now()}-${fileName}`, buffer, mimeType);
  return { sourceUrl: stored.url, fileName, mimeType, width: meta.width, height: meta.height, fileSize: buffer.length };
}

export function buildCleaningPrompt(quality: CleaningQuality) {
  const qualityInstruction = {
    balanced:
      "Use conservative text removal with clean white bubble interiors. Preserve normal line weight and halftone texture.",
    "preserve-detail":
      "Prioritize exact preservation of bubble outlines, panel borders, thin ink lines, screentone, and subtle shading. If a region is ambiguous, preserve it rather than altering it.",
    "maximum-detail":
      "Use the most conservative high-detail restoration. Preserve every original non-text stroke, hatch, screentone dot pattern, highlight, background detail, and character feature. Do not simplify artwork.",
  }[quality];

  return `Edit the provided manga/manhwa page as a precision production cleanup task.

Remove only visible dialogue lettering, narration lettering, sound-effect lettering, punctuation glyphs, and text shadows that are inside speech balloons or caption boxes. Reconstruct the removed areas so each affected balloon interior is clean and naturally white or matches its exact original local background.

Strict preservation rules: preserve the exact canvas dimensions, aspect ratio, panel composition, crop, all characters, faces, clothing, hands, scenery, speech bubble outlines, tails, panel borders, ink contours, screentones, gradients, shadows, highlights, textures, line thickness, and every non-text object. Do not redraw, restyle, recolor, sharpen, blur, crop, expand, translate, add any new text, or change any region outside the text pixels and their immediate erased shadow. Do not remove decorative art that resembles text unless it is clearly lettering.

${qualityInstruction}

Output only the cleaned page with no labels, no watermark, and no added margin.`;
}

export function decodeImageDataUrl(dataUrl: string) {
  const match = /^data:([^;]+);base64,([a-zA-Z0-9+/=\s]+)$/.exec(dataUrl);
  if (!match) {
    throw new Error("صيغة ملف الصورة غير صالحة.");
  }

  const mimeType = match[1].toLowerCase();
  if (!SUPPORTED_IMAGE_TYPES.has(mimeType)) {
    throw new Error("يقبل التطبيق صور PNG أو JPG أو WebP فقط.");
  }

  const buffer = Buffer.from(match[2], "base64");
  if (buffer.length === 0 || buffer.length > MAX_INPUT_BYTES) {
    throw new Error("يجب ألا يتجاوز حجم الصورة 20 ميغابايت.");
  }

  return { mimeType, buffer };
}

function cleanFileName(fileName: string) {
  const safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, "-").replace(/-+/g, "-");
  return safeName.slice(0, 96) || "manga-page.png";
}

export async function cleanMangaBubbleImage(input: {
  imageDataUrl: string;
  fileName: string;
  quality: CleaningQuality;
  width: number;
  height: number;
}) {
  const { mimeType, buffer } = decodeImageDataUrl(input.imageDataUrl);
  const source = await storagePut(
    `manga-bubble-cleaner/originals/${Date.now()}-${cleanFileName(input.fileName)}`,
    buffer,
    mimeType,
  );
  const sourceUrl = await storageGetSignedUrl(source.key);

  const cleaned = await generateImage({
    prompt: buildCleaningPrompt(input.quality),
    originalImages: [{ url: sourceUrl, mimeType }],
    model: "MODEL_GPT_IMAGE_2",
    quality: "high",
  });

  if (!cleaned.url) {
    throw new Error("لم تُنتج المعالجة صورة قابلة للعرض. حاول مرة أخرى.");
  }

  const generatedKey = cleaned.url.replace(/^\/manus-storage\//, "");
  const generatedUrl = await storageGetSignedUrl(generatedKey);
  const generatedResponse = await fetch(generatedUrl);
  if (!generatedResponse.ok) {
    throw new Error("تعذر تنزيل نتيجة التبييض لتحضيرها للتصدير.");
  }
  const generatedBuffer = Buffer.from(await generatedResponse.arrayBuffer());
  const resizedBuffer = await sharp(generatedBuffer)
    .resize({ width: input.width, height: input.height, fit: "fill", kernel: sharp.kernel.lanczos3 })
    .png({ compressionLevel: 9, adaptiveFiltering: true })
    .toBuffer();
  const finalResult = await storagePut(
    `manga-bubble-cleaner/results/${Date.now()}-${cleanFileName(input.fileName).replace(/\.[^.]+$/, "")}.png`,
    resizedBuffer,
    "image/png",
  );

  return {
    resultUrl: finalResult.url,
    sourceUrl: source.url,
  };
}
