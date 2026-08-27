import { generateImage } from "./_core/imageGeneration";
import { storageGetSignedUrl, storagePut } from "./storage";
import sharp from "sharp";

export type CleaningQuality = "balanced" | "preserve-detail" | "maximum-detail";
type BubbleTextRegion = { x: number; y: number; width: number; height: number };
type ManualMaskAdjustment = { mode: "include" | "exclude"; points: Array<{ x: number; y: number }> };

const MAX_INPUT_BYTES = 20 * 1024 * 1024;
const SUPPORTED_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
const TILE_HEIGHT = 1200;
const EXTERNAL_QWEN_BASE_URL = "https://ggg-production-739f.up.railway.app/v1";

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
  return { sourceUrl: stored.url, sourceKey: stored.key, fileName, mimeType, width: meta.width, height: meta.height, fileSize: buffer.length };
}

export function buildCleaningPrompt(quality: CleaningQuality) {
  const detail = quality === "maximum-detail" ? "Preserve every colored gradient, screentone, and ink stroke." : "Preserve normal line weight, colors, and texture.";
  return `Remove only visible dialogue lettering inside speech bubbles. Preserve all non-text artwork, bubble outlines, colors, local backgrounds, dimensions, and composition. ${detail} Do not whiten colored bubbles or redraw the page.`;
}

function buildPatchPrompt(quality: CleaningQuality) {
  const detail = quality === "maximum-detail" ? "Preserve every colored gradient, screentone, reflected light, texture, and ink stroke." : "Preserve all local colors, shading, texture, and bubble style.";
  return `This is a small crop from a manga/manhwa page. Remove only dialogue or narration lettering inside a speech bubble or caption area. Reconstruct the exact local backdrop where the lettering was, including colored bubble fills, gradients, patterns, shading, highlights, or white paper as appropriate. ${detail} Do not alter crop edges, characters, faces, bubble outlines, panel borders, or any non-text area. Do not turn a colored bubble white. Return only the repaired crop with no added text or watermark.`;
}

export function decodeImageDataUrl(dataUrl: string) {
  const match = /^data:([^;]+);base64,([a-zA-Z0-9+/=\s]+)$/.exec(dataUrl);
  if (!match) throw new Error("صيغة ملف الصورة غير صالحة.");
  const mimeType = match[1].toLowerCase();
  if (!SUPPORTED_IMAGE_TYPES.has(mimeType)) throw new Error("يقبل التطبيق صور PNG أو JPG أو WebP فقط.");
  const buffer = Buffer.from(match[2], "base64");
  if (!buffer.length || buffer.length > MAX_INPUT_BYTES) throw new Error("يجب ألا يتجاوز حجم الصورة 20 ميغابايت.");
  return { mimeType, buffer };
}

function cleanFileName(fileName: string) {
  return fileName.replace(/[^a-zA-Z0-9._-]/g, "-").replace(/-+/g, "-").slice(0, 96) || "manga-page.png";
}

type QwenDetectionResponse = { regions?: Array<{ kind?: string; bbox_2d?: unknown; text?: string }> };

function jsonCandidates(raw: string) {
  const fenced = [...raw.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)].map((match) => match[1]);
  const firstObject = raw.indexOf("{"); const lastObject = raw.lastIndexOf("}");
  return [raw, ...fenced, firstObject >= 0 && lastObject > firstObject ? raw.slice(firstObject, lastObject + 1) : ""];
}

/** Parses pixel coordinates returned by qwen, including responses wrapped in prose or Markdown fences. */
export function parseQwenBubbleRegions(raw: string, width: number, height: number): BubbleTextRegion[] {
  for (const candidate of jsonCandidates(raw)) {
    try {
      const parsed = JSON.parse(candidate) as QwenDetectionResponse;
      if (!Array.isArray(parsed.regions)) continue;
      return parsed.regions.flatMap((region) => {
        if (region.kind && region.kind !== "dialogue" && region.kind !== "caption") return [];
        if (!Array.isArray(region.bbox_2d) || region.bbox_2d.length !== 4 || !region.bbox_2d.every((value) => typeof value === "number" && Number.isFinite(value))) return [];
        const [ymin, xmin, ymax, xmax] = region.bbox_2d as number[];
        const left = clamp(Math.round(xmin), 0, width - 1); const top = clamp(Math.round(ymin), 0, height - 1);
        const right = clamp(Math.round(xmax), left + 1, width); const bottom = clamp(Math.round(ymax), top + 1, height);
        if (right - left < 8 || bottom - top < 8) return [];
        return [{ x: left, y: top, width: right - left, height: bottom - top }];
      });
    } catch { /* Try the next JSON candidate. */ }
  }
  return [];
}

async function detectQwenBubbleTextRegions(imageBuffer: Buffer, width: number, height: number): Promise<BubbleTextRegion[]> {
  const apiKey = process.env.EXTERNAL_OPENAI_API_KEY;
  if (!apiKey) throw new Error("مفتاح موفر كشف النص غير مضبوط.");
  if (imageBuffer.length > MAX_INPUT_BYTES) throw new Error("مقطع الصورة أكبر من حد موفر كشف النص.");
  const prompt = `Inspect this ${width}x${height} manhwa crop. Return one JSON object only: {"coordinate_space":"pixels","regions":[{"kind":"dialogue"|"caption","bbox_2d":[ymin,xmin,ymax,xmax],"text":"optional"}]}. Find every readable dialogue or narration text group inside a closed speech bubble or caption box, including white, yellow, red, black, translucent, patterned, or gradient fills. Each bbox must be TIGHT around visible text ink, including fill, outline, glow, and shadow, but never include the bubble border, tail, or empty bubble background. Ignore logos, sound effects, panel borders, and all lettering outside closed bubbles. Use exact pixel coordinates for this supplied image. If there is no eligible text, return {"coordinate_space":"pixels","regions":[]}.`;
  const response = await fetch(`${EXTERNAL_QWEN_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      model: "qwen", temperature: 0, max_tokens: 1200, stream: false,
      messages: [{ role: "user", content: [
        { type: "text", text: prompt },
        { type: "image_url", image_url: { url: `data:image/png;base64,${imageBuffer.toString("base64")}` } },
      ] }],
    }),
    signal: AbortSignal.timeout(180_000),
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`تعذر كشف النص عبر الموفر الخارجي (${response.status}): ${body.slice(0, 240)}`);
  try {
    const payload = JSON.parse(body) as { choices?: Array<{ message?: { content?: unknown } }> };
    const content = payload.choices?.[0]?.message?.content;
    if (typeof content !== "string") throw new Error("رد موفر كشف النص لا يحتوي نصًا صالحًا.");
    return uniqueRegions(parseQwenBubbleRegions(content, width, height));
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("رد موفر")) throw error;
    throw new Error("رد موفر كشف النص ليس بصيغة JSON قابلة للتحليل.");
  }
}

async function detectBubbleTextRegions(tileBuffer: Buffer, width: number, height: number): Promise<BubbleTextRegion[]> {
  return detectQwenBubbleTextRegions(tileBuffer, width, height);
}

function uniqueRegions(regions: BubbleTextRegion[]) {
  return regions.filter((region, index, all) => !all.slice(0, index).some((other) => {
    const ox = Math.max(0, Math.min(region.x + region.width, other.x + other.width) - Math.max(region.x, other.x));
    const oy = Math.max(0, Math.min(region.y + region.height, other.y + other.height) - Math.max(region.y, other.y));
    return (ox * oy) / Math.min(region.width * region.height, other.width * other.height) > 0.7;
  })).slice(0, 6);
}

type Pixel = [number, number, number, number];
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
const mix = (a: Pixel, b: Pixel, amount: number): Pixel => [a[0] + (b[0] - a[0]) * amount, a[1] + (b[1] - a[1]) * amount, a[2] + (b[2] - a[2]) * amount, 255];
const colorDistance = (a: Pixel, b: Pixel) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/** Returns true only when a clean ring around the detected lettering behaves like a smooth bubble fill. */
export function hasSmoothBubbleBackdrop(source: Buffer, width: number, height: number, region: BubbleTextRegion) {
  const read = (x: number, y: number): Pixel => { const offset = (y * width + x) * 4; return [source[offset], source[offset + 1], source[offset + 2], source[offset + 3]]; };
  const ringPadding = 20;
  const x0 = clamp(region.x - ringPadding, 2, width - 3); const y0 = clamp(region.y - ringPadding, 2, height - 3);
  const x1 = clamp(region.x + region.width + ringPadding, x0 + 1, width - 3); const y1 = clamp(region.y + region.height + ringPadding, y0 + 1, height - 3);
  let sum = 0; let rough = 0; let samples = 0;
  const inspect = (x: number, y: number) => {
    const current = read(x, y); const right = read(x + 1, y); const below = read(x, y + 1);
    const local = (colorDistance(current, right) + colorDistance(current, below)) / 2;
    sum += local; if (local > 26) rough += 1; samples += 1;
  };
  for (let x = x0; x <= x1; x += 2) { inspect(x, y0); inspect(x, y1); }
  for (let y = y0 + 2; y < y1; y += 2) { inspect(x0, y); inspect(x1, y); }
  return samples > 8 && sum / samples < 13 && rough / samples < 0.12;
}

/** Rebuilds text layers from the bubble's local colour gradient without touching bubble outlines. */
export function inpaintDetectedTextBoxes(source: Buffer, width: number, height: number, regions: BubbleTextRegion[]) {
  const output = Buffer.from(source);
  const read = (x: number, y: number): Pixel => { const offset = (y * width + x) * 4; return [source[offset], source[offset + 1], source[offset + 2], source[offset + 3]]; };
  const write = (x: number, y: number, color: Pixel) => { const offset = (y * width + x) * 4; output[offset] = Math.round(color[0]); output[offset + 1] = Math.round(color[1]); output[offset + 2] = Math.round(color[2]); output[offset + 3] = source[offset + 3]; };
  const averageAt = (x: number, y: number, direction: "x" | "y"): Pixel => {
    const samples: Pixel[] = [];
    for (let offset = -2; offset <= 2; offset += 1) samples.push(direction === "x" ? read(clamp(x + offset, 0, width - 1), y) : read(x, clamp(y + offset, 0, height - 1)));
    return [samples.reduce((sum, color) => sum + color[0], 0) / samples.length, samples.reduce((sum, color) => sum + color[1], 0) / samples.length, samples.reduce((sum, color) => sum + color[2], 0) / samples.length, 255];
  };
  for (const region of uniqueRegions(regions)) {
    const smoothBackdrop = hasSmoothBubbleBackdrop(source, width, height, region);
    const layerPadding = smoothBackdrop ? clamp(Math.round(Math.min(region.width, region.height) * 0.22), 14, 22) : 4;
    const x0 = clamp(region.x - layerPadding, 6, width - 7); const y0 = clamp(region.y - layerPadding, 6, height - 7);
    const x1 = clamp(region.x + region.width + layerPadding, x0 + 1, width - 7); const y1 = clamp(region.y + region.height + layerPadding, y0 + 1, height - 7);
    const backdropAt = (x: number, y: number) => {
      const horizontal = mix(averageAt(x0 - 4, y, "y"), averageAt(x1 + 4, y, "y"), (x - x0) / Math.max(1, x1 - x0));
      if (smoothBackdrop) return horizontal;
      const vertical = mix(averageAt(x, y0 - 4, "x"), averageAt(x, y1 + 4, "x"), (y - y0) / Math.max(1, y1 - y0));
      return mix(horizontal, vertical, 0.35);
    };
    const boxWidth = x1 - x0 + 1; const boxHeight = y1 - y0 + 1;
    const mask = new Uint8Array(boxWidth * boxHeight);
    for (let y = y0; y <= y1; y += 1) for (let x = x0; x <= x1; x += 1) {
      const backdrop = backdropAt(x, y);
      const current = read(x, y);
      if (colorDistance(current, backdrop) > (smoothBackdrop ? 50 : 20)) mask[(y - y0) * boxWidth + x - x0] = 1;
    }
    const expanded = new Uint8Array(mask);
    const dilationPasses = smoothBackdrop ? 5 : 1;
    for (let pass = 0; pass < dilationPasses; pass += 1) {
      const next = new Uint8Array(expanded);
      for (let y = 1; y < boxHeight - 1; y += 1) for (let x = 1; x < boxWidth - 1; x += 1) {
        if (!expanded[y * boxWidth + x]) continue;
        for (let dy = -1; dy <= 1; dy += 1) for (let dx = -1; dx <= 1; dx += 1) next[(y + dy) * boxWidth + x + dx] = 1;
      }
      expanded.set(next);
    }
    for (let y = y0; y <= y1; y += 1) for (let x = x0; x <= x1; x += 1) {
      if (!expanded[(y - y0) * boxWidth + x - x0]) continue;
      write(x, y, backdropAt(x, y));
    }
  }
  return output;
}

function patchGeometry(region: BubbleTextRegion, width: number, height: number) {
  const padding = 32;
  const side = Math.min(Math.max(region.width, region.height) + padding * 2, width, height, 1024);
  const x = Math.max(0, Math.min(width - side, Math.round(region.x + region.width / 2 - side / 2)));
  const y = Math.max(0, Math.min(height - side, Math.round(region.y + region.height / 2 - side / 2)));
  return { left: x, top: y, width: Math.round(side), height: Math.round(side) };
}

export async function cleanMangaBubbleImage(input: { imageDataUrl: string; fileName: string; quality: CleaningQuality; width: number; height: number }) {
  const source = await storeMangaSource(input.imageDataUrl, input.fileName);
  return cleanStoredMangaBubbleImage({ ...input, ...source });
}

export async function storeMangaSource(imageDataUrl: string, fileName: string) {
  const { mimeType, buffer } = decodeImageDataUrl(imageDataUrl);
  const source = await storagePut(`manga-bubble-cleaner/originals/${Date.now()}-${cleanFileName(fileName)}`, buffer, mimeType);
  return { sourceKey: source.key, sourceUrl: source.url, mimeType };
}

export function manualRegionsForTile(adjustments: ManualMaskAdjustment[] | undefined, pageWidth: number, pageHeight: number, tileTop: number, tileHeight: number) {
  return (adjustments ?? []).flatMap((adjustment) => {
    if (adjustment.mode !== "include" || adjustment.points.length < 2) return [];
    const xs = adjustment.points.map((point) => clamp(point.x, 0, 1) * pageWidth);
    const ys = adjustment.points.map((point) => clamp(point.y, 0, 1) * pageHeight);
    const left = Math.floor(Math.min(...xs)); const right = Math.ceil(Math.max(...xs));
    const top = Math.floor(Math.min(...ys)); const bottom = Math.ceil(Math.max(...ys));
    if (right - left < 8 || bottom - top < 8 || bottom <= tileTop || top >= tileTop + tileHeight) return [];
    return [{ x: left, y: Math.max(top, tileTop) - tileTop, width: right - left, height: Math.min(bottom, tileTop + tileHeight) - Math.max(top, tileTop) }];
  });
}

export async function cleanMangaTile(input: { sourceKey: string; fileName: string; quality: CleaningQuality; width: number; height: number; tileIndex: number; maskAdjustments?: ManualMaskAdjustment[] }) {
  const signedSource = await storageGetSignedUrl(input.sourceKey);
  const sourceResponse = await fetch(signedSource);
  if (!sourceResponse.ok) throw new Error("تعذر تنزيل الصفحة للمقطع الحالي.");
  const sourceBuffer = Buffer.from(await sourceResponse.arrayBuffer());
  const meta = await sharp(sourceBuffer).metadata();
  const width = meta.width ?? input.width;
  const height = meta.height ?? input.height;
  const top = input.tileIndex * TILE_HEIGHT;
  if (top >= height) throw new Error("رقم المقطع خارج حدود الصفحة.");
  const currentHeight = Math.min(TILE_HEIGHT, height - top);
  const tile = await sharp(sourceBuffer).extract({ left: 0, top, width, height: currentHeight }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const tileBuffer = await sharp(tile.data, { raw: { width, height: currentHeight, channels: 4 } }).png().toBuffer();
  const detectedRegions = await detectBubbleTextRegions(tileBuffer, width, currentHeight);
  const manualRegions = manualRegionsForTile(input.maskAdjustments, width, height, top, currentHeight);
  const regions = uniqueRegions([...detectedRegions, ...manualRegions]);
  const repairedRaw = inpaintDetectedTextBoxes(tile.data, width, currentHeight, regions);
  const repairedTile = await sharp(repairedRaw, { raw: { width, height: currentHeight, channels: 4 } }).png({ compressionLevel: 6, adaptiveFiltering: true }).toBuffer();
  const finalBuffer = await sharp(sourceBuffer).composite([{ input: repairedTile, left: 0, top }]).png({ compressionLevel: 6, adaptiveFiltering: true }).toBuffer();
  const result = await storagePut(`manga-bubble-cleaner/tile-results/${Date.now()}-${input.tileIndex}-${cleanFileName(input.fileName).replace(/\.[^.]+$/, "")}.png`, finalBuffer, "image/png");
  return { resultKey: result.key, resultUrl: result.url, tileCount: Math.ceil(height / TILE_HEIGHT), detectedRegions: detectedRegions.length, detectedBoxes: detectedRegions, manualRegions: manualRegions.length, processedRegions: regions.length };
}

export async function cleanStoredMangaBubbleImage(input: { sourceKey: string; sourceUrl?: string; fileName: string; quality: CleaningQuality; width: number; height: number; mimeType: string }) {
  if (!SUPPORTED_IMAGE_TYPES.has(input.mimeType)) throw new Error("يقبل التطبيق صور PNG أو JPG أو WebP فقط.");
  const signedSource = await storageGetSignedUrl(input.sourceKey);
  const sourceResponse = await fetch(signedSource);
  if (!sourceResponse.ok) throw new Error("تعذر تنزيل الصورة الأصلية للمعالجة.");
  const sourceBuffer = Buffer.from(await sourceResponse.arrayBuffer());
  const meta = await sharp(sourceBuffer).metadata();
  const width = meta.width ?? input.width;
  const height = meta.height ?? input.height;
  const regions: BubbleTextRegion[] = [];
  const tileHeight = 3000;

  for (let top = 0; top < height; top += tileHeight) {
    const currentHeight = Math.min(tileHeight, height - top);
    const tileBuffer = await sharp(sourceBuffer).extract({ left: 0, top, width, height: currentHeight }).png().toBuffer();
    const boxes = await detectBubbleTextRegions(tileBuffer, width, currentHeight);
    regions.push(...boxes.map((box) => ({ ...box, y: box.y + top })));
  }

  const overlays: Array<{ input: Buffer; left: number; top: number }> = [];
  for (const region of uniqueRegions(regions)) {
    const patch = patchGeometry(region, width, height);
    const patchBuffer = await sharp(sourceBuffer).extract(patch).png().toBuffer();
    const storedPatch = await storagePut(`manga-bubble-cleaner/patches/${Date.now()}-${patch.left}-${patch.top}.png`, patchBuffer, "image/png");
    const repaired = await generateImage({ prompt: buildPatchPrompt(input.quality), originalImages: [{ url: await storageGetSignedUrl(storedPatch.key), mimeType: "image/png" }], model: "MODEL_GPT_IMAGE_2", quality: "high" });
    if (!repaired.url) continue;
    const key = repaired.url.replace(/^\/manus-storage\//, "");
    const response = await fetch(await storageGetSignedUrl(key));
    if (!response.ok) continue;
    const repairedPatch = await sharp(Buffer.from(await response.arrayBuffer())).resize({ width: patch.width, height: patch.height, fit: "fill", kernel: sharp.kernel.lanczos3 }).png().toBuffer();
    overlays.push({ input: repairedPatch, left: patch.left, top: patch.top });
  }

  const finalBuffer = await sharp(sourceBuffer).composite(overlays).png({ compressionLevel: 9, adaptiveFiltering: true }).toBuffer();
  const finalResult = await storagePut(`manga-bubble-cleaner/results/${Date.now()}-${cleanFileName(input.fileName).replace(/\.[^.]+$/, "")}.png`, finalBuffer, "image/png");
  return { resultUrl: finalResult.url, sourceUrl: input.sourceUrl ?? `/manus-storage/${input.sourceKey}`, processedRegions: overlays.length };
}
