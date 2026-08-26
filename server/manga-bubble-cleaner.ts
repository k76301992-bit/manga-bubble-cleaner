import { generateImage } from "./_core/imageGeneration";
import { storageGetSignedUrl, storagePut } from "./storage";
import sharp from "sharp";

export type CleaningQuality = "balanced" | "preserve-detail" | "maximum-detail";

const MAX_INPUT_BYTES = 20 * 1024 * 1024;
const SUPPORTED_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

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
