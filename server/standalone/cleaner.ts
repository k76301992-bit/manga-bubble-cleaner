import sharp from "sharp";

export type CleaningQuality = "balanced" | "preserve-detail" | "maximum-detail";
export type BubbleTextRegion = { x: number; y: number; width: number; height: number };
export type ManualMaskAdjustment = { mode: "include" | "exclude"; points: Array<{ x: number; y: number }> };

const MAX_INPUT_BYTES = 20 * 1024 * 1024;
const MAX_WIDTH = 12000;
const MAX_HEIGHT = 30000;
export const TILE_HEIGHT = 1200;
const EXTERNAL_QWEN_BASE_URL = process.env.EXTERNAL_QWEN_BASE_URL || "https://ggg-production-739f.up.railway.app/v1";
const SUPPORTED_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

type Pixel = [number, number, number, number];
type QwenDetectionResponse = { regions?: Array<{ kind?: string; bbox_2d?: unknown }> };

function colorDistance(a: Pixel, b: Pixel) { return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]); }
function mix(a: Pixel, b: Pixel, amount: number): Pixel { return [a[0] + (b[0] - a[0]) * amount, a[1] + (b[1] - a[1]) * amount, a[2] + (b[2] - a[2]) * amount, 255]; }

function uniqueRegions(regions: BubbleTextRegion[]) {
  return regions.filter((region, index, all) => !all.slice(0, index).some((other) => {
    const ox = Math.max(0, Math.min(region.x + region.width, other.x + other.width) - Math.max(region.x, other.x));
    const oy = Math.max(0, Math.min(region.y + region.height, other.y + other.height) - Math.max(region.y, other.y));
    return (ox * oy) / Math.min(region.width * region.height, other.width * other.height) > 0.7;
  })).slice(0, 6);
}

function jsonCandidates(raw: string) {
  const fenced = [...raw.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)].map((match) => match[1]);
  const firstObject = raw.indexOf("{"); const lastObject = raw.lastIndexOf("}");
  return [raw, ...fenced, firstObject >= 0 && lastObject > firstObject ? raw.slice(firstObject, lastObject + 1) : ""];
}

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
        return right - left < 8 || bottom - top < 8 ? [] : [{ x: left, y: top, width: right - left, height: bottom - top }];
      });
    } catch { /* The model may include prose before its JSON. */ }
  }
  return [];
}

async function detectBubbleTextRegions(imageBuffer: Buffer, width: number, height: number) {
  const apiKey = process.env.EXTERNAL_OPENAI_API_KEY;
  if (!apiKey) throw new Error("مفتاح موفر كشف النص غير مضبوط على الخادم.");
  const prompt = `Inspect this ${width}x${height} manhwa crop. Return one JSON object only: {"coordinate_space":"pixels","regions":[{"kind":"dialogue"|"caption","bbox_2d":[ymin,xmin,ymax,xmax]}]}. Find readable dialogue or narration text inside a closed speech bubble or caption box. Each bbox must be tight around text ink, including fill, outline, glow, and shadow, but never include a bubble border, tail, or empty background. Ignore logos, sound effects, panel borders, and text outside closed bubbles. Use exact pixel coordinates. If there is no eligible text, return {"coordinate_space":"pixels","regions":[]}.`;
  const response = await fetch(`${EXTERNAL_QWEN_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ model: "qwen", temperature: 0, max_tokens: 1200, stream: false, messages: [{ role: "user", content: [{ type: "text", text: prompt }, { type: "image_url", image_url: { url: `data:image/png;base64,${imageBuffer.toString("base64")}` } }] }] }),
    signal: AbortSignal.timeout(180_000),
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`تعذر كشف النص عبر الموفر الخارجي (${response.status}): ${body.slice(0, 240)}`);
  try {
    const payload = JSON.parse(body) as { choices?: Array<{ message?: { content?: unknown } }> };
    const content = payload.choices?.[0]?.message?.content;
    if (typeof content !== "string") throw new Error("invalid");
    return uniqueRegions(parseQwenBubbleRegions(content, width, height));
  } catch { throw new Error("رد موفر كشف النص ليس بصيغة JSON قابلة للتحليل."); }
}

export function hasSmoothBubbleBackdrop(source: Buffer, width: number, height: number, region: BubbleTextRegion) {
  const read = (x: number, y: number): Pixel => { const o = (y * width + x) * 4; return [source[o], source[o + 1], source[o + 2], source[o + 3]]; };
  const padding = 20; const x0 = clamp(region.x - padding, 2, width - 3); const y0 = clamp(region.y - padding, 2, height - 3); const x1 = clamp(region.x + region.width + padding, x0 + 1, width - 3); const y1 = clamp(region.y + region.height + padding, y0 + 1, height - 3);
  let sum = 0; let rough = 0; let samples = 0;
  const inspect = (x: number, y: number) => { const current = read(x, y); const local = (colorDistance(current, read(x + 1, y)) + colorDistance(current, read(x, y + 1))) / 2; sum += local; if (local > 26) rough += 1; samples += 1; };
  for (let x = x0; x <= x1; x += 2) { inspect(x, y0); inspect(x, y1); }
  for (let y = y0 + 2; y < y1; y += 2) { inspect(x0, y); inspect(x1, y); }
  return samples > 8 && sum / samples < 13 && rough / samples < 0.12;
}

export function inpaintDetectedTextBoxes(source: Buffer, width: number, height: number, regions: BubbleTextRegion[]) {
  const output = Buffer.from(source);
  const read = (x: number, y: number): Pixel => { const o = (y * width + x) * 4; return [source[o], source[o + 1], source[o + 2], source[o + 3]]; };
  const write = (x: number, y: number, c: Pixel) => { const o = (y * width + x) * 4; output[o] = Math.round(c[0]); output[o + 1] = Math.round(c[1]); output[o + 2] = Math.round(c[2]); output[o + 3] = source[o + 3]; };
  const averageAt = (x: number, y: number, direction: "x" | "y"): Pixel => {
    const samples: Pixel[] = []; for (let offset = -2; offset <= 2; offset += 1) samples.push(direction === "x" ? read(clamp(x + offset, 0, width - 1), y) : read(x, clamp(y + offset, 0, height - 1)));
    return [samples.reduce((sum, c) => sum + c[0], 0) / 5, samples.reduce((sum, c) => sum + c[1], 0) / 5, samples.reduce((sum, c) => sum + c[2], 0) / 5, 255];
  };
  for (const region of uniqueRegions(regions)) {
    const smooth = hasSmoothBubbleBackdrop(source, width, height, region); const layerPadding = smooth ? clamp(Math.round(Math.min(region.width, region.height) * 0.22), 14, 22) : 4;
    const x0 = clamp(region.x - layerPadding, 6, width - 7); const y0 = clamp(region.y - layerPadding, 6, height - 7); const x1 = clamp(region.x + region.width + layerPadding, x0 + 1, width - 7); const y1 = clamp(region.y + region.height + layerPadding, y0 + 1, height - 7);
    const backdropAt = (x: number, y: number) => {
      const horizontal = mix(averageAt(x0 - 4, y, "y"), averageAt(x1 + 4, y, "y"), (x - x0) / Math.max(1, x1 - x0));
      if (smooth) return horizontal;
      return mix(horizontal, mix(averageAt(x, y0 - 4, "x"), averageAt(x, y1 + 4, "x"), (y - y0) / Math.max(1, y1 - y0)), 0.35);
    };
    const boxWidth = x1 - x0 + 1; const boxHeight = y1 - y0 + 1; const mask = new Uint8Array(boxWidth * boxHeight);
    for (let y = y0; y <= y1; y += 1) for (let x = x0; x <= x1; x += 1) if (colorDistance(read(x, y), backdropAt(x, y)) > (smooth ? 50 : 20)) mask[(y - y0) * boxWidth + x - x0] = 1;
    const expanded = new Uint8Array(mask);
    for (let pass = 0; pass < (smooth ? 5 : 1); pass += 1) { const next = new Uint8Array(expanded); for (let y = 1; y < boxHeight - 1; y += 1) for (let x = 1; x < boxWidth - 1; x += 1) if (expanded[y * boxWidth + x]) for (let dy = -1; dy <= 1; dy += 1) for (let dx = -1; dx <= 1; dx += 1) next[(y + dy) * boxWidth + x + dx] = 1; expanded.set(next); }
    for (let y = y0; y <= y1; y += 1) for (let x = x0; x <= x1; x += 1) if (expanded[(y - y0) * boxWidth + x - x0]) write(x, y, backdropAt(x, y));
  }
  return output;
}

export function manualRegionsForTile(adjustments: ManualMaskAdjustment[] | undefined, pageWidth: number, pageHeight: number, tileTop: number, tileHeight: number) {
  return (adjustments ?? []).flatMap((adjustment) => {
    if (adjustment.mode !== "include" || adjustment.points.length < 2) return [];
    const xs = adjustment.points.map((point) => clamp(point.x, 0, 1) * pageWidth); const ys = adjustment.points.map((point) => clamp(point.y, 0, 1) * pageHeight);
    const left = Math.floor(Math.min(...xs)); const right = Math.ceil(Math.max(...xs)); const top = Math.floor(Math.min(...ys)); const bottom = Math.ceil(Math.max(...ys));
    return right - left < 8 || bottom - top < 8 || bottom <= tileTop || top >= tileTop + tileHeight ? [] : [{ x: left, y: Math.max(top, tileTop) - tileTop, width: right - left, height: Math.min(bottom, tileTop + tileHeight) - Math.max(top, tileTop) }];
  });
}

export async function cleanImageInMemory(input: { image: Buffer; mimeType: string; quality: CleaningQuality; maskAdjustments?: ManualMaskAdjustment[]; onTile?: (info: { tileIndex: number; tileCount: number; status: "detecting" | "cleaning" }) => Promise<void> | void }) {
  if (!SUPPORTED_MIME_TYPES.has(input.mimeType)) throw new Error("يقبل الخادم صور PNG أو JPG أو WebP فقط.");
  if (!input.image.length || input.image.length > MAX_INPUT_BYTES) throw new Error("يجب ألا تتجاوز الصورة 20 ميغابايت.");
  const metadata = await sharp(input.image).metadata(); const width = metadata.width ?? 0; const height = metadata.height ?? 0;
  if (!width || !height || width > MAX_WIDTH || height > MAX_HEIGHT) throw new Error("أبعاد الصورة غير مدعومة.");
  let currentImage = input.image; const tileCount = Math.ceil(height / TILE_HEIGHT); let detectedRegions = 0;
  for (let tileIndex = 0; tileIndex < tileCount; tileIndex += 1) {
    const top = tileIndex * TILE_HEIGHT; const currentHeight = Math.min(TILE_HEIGHT, height - top);
    const tile = await sharp(currentImage).extract({ left: 0, top, width, height: currentHeight }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const visionInput = await sharp(tile.data, { raw: { width, height: currentHeight, channels: 4 } }).png().toBuffer();
    await input.onTile?.({ tileIndex, tileCount, status: "detecting" });
    const detected = await detectBubbleTextRegions(visionInput, width, currentHeight); detectedRegions += detected.length;
    const regions = uniqueRegions([...detected, ...manualRegionsForTile(input.maskAdjustments, width, height, top, currentHeight)]);
    await input.onTile?.({ tileIndex, tileCount, status: "cleaning" });
    const repairedRaw = inpaintDetectedTextBoxes(tile.data, width, currentHeight, regions);
    const repairedTile = await sharp(repairedRaw, { raw: { width, height: currentHeight, channels: 4 } }).png({ compressionLevel: 6, adaptiveFiltering: true }).toBuffer();
    currentImage = await sharp(currentImage).composite([{ input: repairedTile, left: 0, top }]).png({ compressionLevel: 6, adaptiveFiltering: true }).toBuffer();
  }
  return { image: currentImage, width, height, tileCount, detectedRegions };
}
