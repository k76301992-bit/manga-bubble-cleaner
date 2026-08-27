import sharp from "sharp";

export type CleaningQuality = "balanced" | "preserve-detail" | "maximum-detail";
export type BubbleTextRegion = { x: number; y: number; width: number; height: number };
export type ManualMaskAdjustment = { mode: "include" | "exclude"; points: Array<{ x: number; y: number }> };

const MAX_INPUT_BYTES = 20 * 1024 * 1024;
const MAX_WIDTH = 12000;
const MAX_HEIGHT = 30000;
export const TILE_HEIGHT = 1200;
const EXTERNAL_QWEN_BASE_URL = process.env.EXTERNAL_QWEN_BASE_URL || "https://ggg-production-739f.up.railway.app/v1";
const EXTERNAL_QWEN_MODEL = process.env.EXTERNAL_QWEN_MODEL || "qwen";
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

export async function detectFallbackDarkTextRegions(imageBuffer: Buffer, width: number, height: number): Promise<BubbleTextRegion[]> {
  const { data } = await sharp(imageBuffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const ink = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const offset = (y * width + x) * 4; const red = data[offset]; const green = data[offset + 1]; const blue = data[offset + 2];
    const brightness = (red * 0.299) + (green * 0.587) + (blue * 0.114);
    if (data[offset + 3] > 200 && brightness < 150) ink[y * width + x] = 1;
  }
  const visited = new Uint8Array(width * height);
  const glyphs: Array<{ x: number; y: number; width: number; height: number }> = [];
  for (let start = 0; start < ink.length; start += 1) {
    if (!ink[start] || visited[start]) continue;
    const stack = [start]; visited[start] = 1; let count = 0; let minX = width; let minY = height; let maxX = 0; let maxY = 0;
    while (stack.length) {
      const point = stack.pop()!; const x = point % width; const y = Math.floor(point / width); count += 1;
      minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
      for (let dy = -1; dy <= 1; dy += 1) for (let dx = -1; dx <= 1; dx += 1) {
        const nx = x + dx; const ny = y + dy; const next = ny * width + nx;
        if (nx >= 0 && nx < width && ny >= 0 && ny < height && ink[next] && !visited[next]) { visited[next] = 1; stack.push(next); }
      }
    }
    const glyphWidth = maxX - minX + 1; const glyphHeight = maxY - minY + 1;
    if (count >= 8 && glyphWidth >= 2 && glyphWidth <= 620 && glyphHeight >= 4 && glyphHeight <= 100) glyphs.push({ x: minX, y: minY, width: glyphWidth, height: glyphHeight });
  }
  glyphs.sort((a, b) => a.y - b.y || a.x - b.x);
  const groups: Array<BubbleTextRegion & { glyphCount: number }> = [];
  for (const glyph of glyphs) {
    const centerY = glyph.y + glyph.height / 2;
    const group = groups.find((candidate) => {
      const candidateCenterY = candidate.y + candidate.height / 2;
      const horizontalGap = glyph.x > candidate.x + candidate.width ? glyph.x - (candidate.x + candidate.width) : candidate.x > glyph.x + glyph.width ? candidate.x - (glyph.x + glyph.width) : 0;
      return Math.abs(centerY - candidateCenterY) <= Math.max(18, Math.max(glyph.height, candidate.height) * 0.75) && horizontalGap <= 34;
    });
    if (!group) groups.push({ ...glyph, glyphCount: 1 });
    else {
      const right = Math.max(group.x + group.width, glyph.x + glyph.width); const bottom = Math.max(group.y + group.height, glyph.y + glyph.height);
      group.x = Math.min(group.x, glyph.x); group.y = Math.min(group.y, glyph.y); group.width = right - group.x; group.height = bottom - group.y; group.glyphCount += 1;
    }
  }
  const lineGroups: Array<BubbleTextRegion & { glyphCount: number }> = [];
  for (const group of [...groups].sort((a, b) => a.y - b.y || a.x - b.x)) {
    const groupCenterY = group.y + group.height / 2;
    const existing = lineGroups.find((candidate) => {
      const candidateCenterY = candidate.y + candidate.height / 2;
      const horizontalGap = group.x > candidate.x + candidate.width ? group.x - (candidate.x + candidate.width) : candidate.x > group.x + group.width ? candidate.x - (group.x + group.width) : 0;
      return Math.abs(groupCenterY - candidateCenterY) <= Math.max(18, Math.max(group.height, candidate.height) * 0.75) && horizontalGap <= 42;
    });
    if (!existing) lineGroups.push({ ...group });
    else {
      const right = Math.max(existing.x + existing.width, group.x + group.width); const bottom = Math.max(existing.y + existing.height, group.y + group.height);
      existing.x = Math.min(existing.x, group.x); existing.y = Math.min(existing.y, group.y); existing.width = right - existing.x; existing.height = bottom - existing.y; existing.glyphCount += group.glyphCount;
    }
  }
  const read = (x: number, y: number): Pixel => { const offset = (clamp(y, 0, height - 1) * width + clamp(x, 0, width - 1)) * 4; return [data[offset], data[offset + 1], data[offset + 2], data[offset + 3]]; };
  const likelySmoothLightBubble = (region: BubbleTextRegion) => {
    const samples = [[region.x - 7, region.y + region.height / 2], [region.x + region.width + 7, region.y + region.height / 2], [region.x + region.width / 2, region.y - 7], [region.x + region.width / 2, region.y + region.height + 7]];
    const colors = samples.map(([x, y]) => read(Math.round(x), Math.round(y))); const lightness = colors.reduce((sum, color) => sum + ((color[0] * 0.299) + (color[1] * 0.587) + (color[2] * 0.114)), 0) / colors.length;
    const spread = Math.max(...colors.map((color) => colorDistance(color, colors[0])));
    const chroma = colors.reduce((sum, color) => sum + (Math.max(color[0], color[1], color[2]) - Math.min(color[0], color[1], color[2])), 0) / colors.length;
    return lightness >= 175 && spread < 90 && chroma < 80;
  };
  const accepted = uniqueRegions(lineGroups.filter((group) => group.glyphCount >= 1 && group.width >= 18 && group.width <= 620 && group.height >= 10 && group.height <= 150 && group.width / group.height >= 1.15 && likelySmoothLightBubble(group)).map(({ glyphCount: _glyphCount, ...region }) => region));
  return accepted;
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
  if (!apiKey) throw new Error("مفتاح موفر كشف النص غير مضبوط.");
  if (imageBuffer.length > MAX_INPUT_BYTES) throw new Error("مقطع الصورة أكبر من حد موفر كشف النص.");
  const prompt = `Inspect this ${width}x${height} manhwa crop. Return one JSON object only: {"coordinate_space":"pixels","regions":[{"kind":"dialogue"|"caption","bbox_2d":[ymin,xmin,ymax,xmax],"text":"optional"}]}. Find every readable dialogue or narration text group inside a closed speech bubble or caption box, including white, yellow, red, black, translucent, patterned, or gradient fills. Each bbox must be TIGHT around visible text ink, including fill, outline, glow, and shadow, but never include the bubble border, tail, or empty bubble background. Ignore logos, sound effects, panel borders, and all lettering outside closed bubbles. Use exact pixel coordinates for this supplied image. If there is no eligible text, return {"coordinate_space":"pixels","regions":[]}.`;
  const request = {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      model: EXTERNAL_QWEN_MODEL, temperature: 0, max_tokens: 1200, stream: false,
      messages: [{ role: "user", content: [
        { type: "text", text: prompt },
        { type: "image_url", image_url: { url: `data:image/png;base64,${imageBuffer.toString("base64")}` } },
      ] }],
    }),
  };
  for (let contentAttempt = 0; contentAttempt < 2; contentAttempt += 1) {
    let response: Response | undefined;
    let networkError: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try { response = await fetch(`${EXTERNAL_QWEN_BASE_URL}/chat/completions`, { ...request, signal: AbortSignal.timeout(180_000) }); break; }
      catch (error) { networkError = error; if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, (attempt + 1) * 700)); }
    }
    if (!response) throw new Error(`تعذر الاتصال بموفر كشف النص بعد 3 محاولات: ${networkError instanceof Error ? networkError.message : "خطأ شبكة"}`);
    const body = await response.text();
    if (!response.ok) throw new Error(`تعذر كشف النص عبر الموفر الخارجي (${response.status}): ${body.slice(0, 240)}`);
    try {
      const payload = JSON.parse(body) as { choices?: Array<{ message?: { content?: unknown } }> };
      const content = payload.choices?.[0]?.message?.content;
      if (typeof content !== "string") throw new Error("رد موفر كشف النص لا يحتوي نصًا صالحًا.");
      if (content.trim() === "[Qwen: empty response]") {
        if (contentAttempt === 0) { await new Promise((resolve) => setTimeout(resolve, 600)); continue; }
        const fallback = await detectFallbackDarkTextRegions(imageBuffer, width, height);
        if (fallback.length) return fallback;
        throw new Error("موفر كشف النص أعاد استجابة فارغة ولم يجد الفحص المحلي نصًا آمنًا للتبييض؛ لم تُعالج الصورة حتى لا يعيد الخادم نسخة غير منظفة.");
      }
      return uniqueRegions(parseQwenBubbleRegions(content, width, height));
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("رد موفر")) throw error;
      throw new Error("رد موفر كشف النص ليس بصيغة JSON قابلة للتحليل.");
    }
  }
  return [];
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
