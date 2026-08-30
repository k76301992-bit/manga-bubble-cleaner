import sharp from "sharp";
import { requestLocalComicTextDetection, requestLocalComicTextDetectionWithMask, requestTrainedInpainting } from "./inpainting-client";

export type CleaningQuality = "balanced" | "preserve-detail" | "maximum-detail";
export type BubbleTextRegion = { x: number; y: number; width: number; height: number };
export type ManualMaskAdjustment = { mode: "include" | "exclude"; points: Array<{ x: number; y: number }> };

const MAX_INPUT_BYTES = 20 * 1024 * 1024;
const MAX_WIDTH = 12000;
const MAX_HEIGHT = 30000;
export const TILE_HEIGHT = 3200;
const TILE_OVERLAP = 56;
const EXTERNAL_QWEN_BASE_URL = process.env.EXTERNAL_QWEN_BASE_URL || process.env.EXTERNAL_OPENAI_BASE_URL || "https://ggg-production-739f.up.railway.app/v1";
const EXTERNAL_QWEN_MODEL = process.env.EXTERNAL_QWEN_MODEL || process.env.EXTERNAL_OPENAI_MODEL || "qwen";
const SUPPORTED_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

type Pixel = [number, number, number, number];
type QwenDetectionResponse = { regions?: Array<{ kind?: string; bbox_2d?: unknown }> };

type CleaningProfile = {
  tileHeight: number;
  requestTimeoutMs: number;
  maxRegionsPerTile: number;
  useRemoteWhenLocalMisses: boolean;
  useRemoteAlongsideLocal: boolean;
  useTrainedInpainting: boolean;
  trainedOnly: boolean;
};

export function cleaningProfileFor(quality: CleaningQuality): CleaningProfile {
  if (quality === "balanced") return { tileHeight: 4000, requestTimeoutMs: 25_000, maxRegionsPerTile: 12, useRemoteWhenLocalMisses: false, useRemoteAlongsideLocal: false, useTrainedInpainting: false, trainedOnly: false };
  if (quality === "maximum-detail") return { tileHeight: 2400, requestTimeoutMs: 15_000, maxRegionsPerTile: 48, useRemoteWhenLocalMisses: true, useRemoteAlongsideLocal: true, useTrainedInpainting: true, trainedOnly: true };
  return { tileHeight: TILE_HEIGHT, requestTimeoutMs: 12_000, maxRegionsPerTile: 24, useRemoteWhenLocalMisses: true, useRemoteAlongsideLocal: false, useTrainedInpainting: true, trainedOnly: false };
}

function colorDistance(a: Pixel, b: Pixel) { return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]); }
function mix(a: Pixel, b: Pixel, amount: number): Pixel { return [a[0] + (b[0] - a[0]) * amount, a[1] + (b[1] - a[1]) * amount, a[2] + (b[2] - a[2]) * amount, 255]; }

function uniqueRegions(regions: BubbleTextRegion[], maximum = 12) {
  return regions.filter((region, index, all) => !all.slice(0, index).some((other) => {
    const ox = Math.max(0, Math.min(region.x + region.width, other.x + other.width) - Math.max(region.x, other.x));
    const oy = Math.max(0, Math.min(region.y + region.height, other.y + other.height) - Math.max(region.y, other.y));
    return (ox * oy) / Math.min(region.width * region.height, other.width * other.height) > 0.7;
  })).slice(0, maximum);
}

export function mergeAdjacentTextLines(regions: BubbleTextRegion[]) {
  const merged: BubbleTextRegion[] = [];
  for (const region of [...regions].sort((a, b) => a.y - b.y || a.x - b.x)) {
    const candidate = merged.find((existing) => {
      const existingBottom = existing.y + existing.height;
      const verticalGap = region.y > existingBottom ? region.y - existingBottom : existing.y > region.y + region.height ? existing.y - (region.y + region.height) : 0;
      const horizontalOverlap = Math.max(0, Math.min(existing.x + existing.width, region.x + region.width) - Math.max(existing.x, region.x));
      const aligned = horizontalOverlap / Math.max(1, Math.min(existing.width, region.width)) >= 0.28 || Math.abs((existing.x + existing.width / 2) - (region.x + region.width / 2)) <= Math.max(existing.width, region.width) * 0.42;
      return verticalGap <= Math.max(30, Math.max(existing.height, region.height) * 1.6) && aligned;
    });
    if (!candidate) merged.push({ ...region });
    else {
      const right = Math.max(candidate.x + candidate.width, region.x + region.width); const bottom = Math.max(candidate.y + candidate.height, region.y + region.height);
      candidate.x = Math.min(candidate.x, region.x); candidate.y = Math.min(candidate.y, region.y); candidate.width = right - candidate.x; candidate.height = bottom - candidate.y;
    }
  }
  return merged;
}

function jsonCandidates(raw: string) {
  const fenced = [...raw.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)].map((match) => match[1]);
  const firstObject = raw.indexOf("{"); const lastObject = raw.lastIndexOf("}");
  return [raw, ...fenced, firstObject >= 0 && lastObject > firstObject ? raw.slice(firstObject, lastObject + 1) : ""];
}

export function hasLikelyClosedBubbleOutline(source: Buffer, width: number, height: number, region: BubbleTextRegion) {
  const isDark = (x: number, y: number) => {
    const offset = (clamp(y, 0, height - 1) * width + clamp(x, 0, width - 1)) * 4;
    return (source[offset] * 0.299) + (source[offset + 1] * 0.587) + (source[offset + 2] * 0.114) < 105;
  };
  const limit = clamp(Math.round(Math.max(region.width, region.height) * 0.8), 20, 112);
  const offsets = [0.2, 0.5, 0.8];
  const scan = (x: number, y: number, dx: number, dy: number) => {
    for (let distance = 8; distance <= limit; distance += 1) if (isDark(x + dx * distance, y + dy * distance)) return true;
    return false;
  };
  const topHits = offsets.filter((offset) => scan(Math.round(region.x + region.width * offset), region.y, 0, -1)).length;
  const bottomHits = offsets.filter((offset) => scan(Math.round(region.x + region.width * offset), region.y + region.height, 0, 1)).length;
  const leftHits = offsets.filter((offset) => scan(region.x, Math.round(region.y + region.height * offset), -1, 0)).length;
  const rightHits = offsets.filter((offset) => scan(region.x + region.width, Math.round(region.y + region.height * offset), 1, 0)).length;
  return topHits >= 2 && bottomHits >= 2 && leftHits >= 2 && rightHits >= 2;
}

type NeutralBubbleArea = BubbleTextRegion & { id: number };

function findNeutralBubbleAreas(source: Buffer, width: number, height: number) {
  const labels = new Int32Array(width * height);
  const areas: NeutralBubbleArea[] = [];
  let nextId = 1;
  const isNeutralLight = (index: number) => {
    const offset = index * 4; const red = source[offset]; const green = source[offset + 1]; const blue = source[offset + 2];
    return source[offset + 3] > 220 && (red * 0.299) + (green * 0.587) + (blue * 0.114) >= 238 && Math.max(red, green, blue) - Math.min(red, green, blue) <= 26;
  };
  for (let start = 0; start < labels.length; start += 1) {
    if (labels[start] || !isNeutralLight(start)) continue;
    const id = nextId++; const queue = [start]; labels[start] = id; let cursor = 0; let count = 0; let minX = width; let maxX = 0; let minY = height; let maxY = 0;
    while (cursor < queue.length) {
      const index = queue[cursor++]; const x = index % width; const y = Math.floor(index / width); count += 1; minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
      for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
        const nx = x + dx; const ny = y + dy; const next = ny * width + nx;
        if (nx >= 0 && nx < width && ny >= 0 && ny < height && !labels[next] && isNeutralLight(next)) { labels[next] = id; queue.push(next); }
      }
    }
    const bubbleWidth = maxX - minX + 1; const bubbleHeight = maxY - minY + 1;
    const touchesTile = minX === 0 || minY === 0 || maxX === width - 1 || maxY === height - 1;
    if (!touchesTile && count >= 420 && bubbleWidth >= 34 && bubbleHeight >= 26 && bubbleWidth < width * 0.9 && bubbleHeight < height * 0.65) areas.push({ id, x: minX, y: minY, width: bubbleWidth, height: bubbleHeight });
  }
  return { labels, areas };
}

function splitRegionAcrossNeutralBubbles(region: BubbleTextRegion, areas: NeutralBubbleArea[]) {
  const overlaps = areas.filter((area) => {
    const overlapWidth = Math.max(0, Math.min(region.x + region.width, area.x + area.width) - Math.max(region.x, area.x));
    const overlapHeight = Math.max(0, Math.min(region.y + region.height, area.y + area.height) - Math.max(region.y, area.y));
    return overlapWidth * overlapHeight >= Math.max(24, region.width * region.height * 0.04);
  });
  if (overlaps.length < 2) return [region];
  return overlaps.map((area) => {
    const left = Math.max(region.x, area.x + 2); const top = Math.max(region.y, area.y + 2);
    const right = Math.min(region.x + region.width, area.x + area.width - 2); const bottom = Math.min(region.y + region.height, area.y + area.height - 2);
    return right - left >= 8 && bottom - top >= 8 ? { x: left, y: top, width: right - left, height: bottom - top } : undefined;
  }).filter((item): item is BubbleTextRegion => Boolean(item));
}

function isInsideNeutralBubble(region: BubbleTextRegion, areas: NeutralBubbleArea[], labels: Int32Array, width: number, height: number) {
  const centerX = Math.round(region.x + region.width / 2); const centerY = Math.round(region.y + region.height / 2);
  return areas.some((area) => {
    if (area.width < region.width + 18 || area.height < region.height + 18 || area.width * area.height < region.width * region.height * 1.8) return false;
    if (centerX <= area.x + 2 || centerX >= area.x + area.width - 3 || centerY <= area.y + 2 || centerY >= area.y + area.height - 3) return false;
    const probes = [[region.x - 5, centerY], [region.x + region.width + 5, centerY], [centerX, region.y - 5], [centerX, region.y + region.height + 5]];
    const hits = probes.filter(([x, y]) => labels[clamp(Math.round(y), 0, height - 1) * width + clamp(Math.round(x), 0, width - 1)] === area.id).length;
    return hits >= 2;
  });
}

export async function detectFallbackDarkTextRegions(imageBuffer: Buffer, width: number, height: number, includeSmoothColourBubbles = false, maximumRegions = 12, requireClosedBubbleOutline = false): Promise<BubbleTextRegion[]> {
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
    return lightness >= 210 && spread < 58 && chroma < 38;
  };
  const bubbleGroups = mergeAdjacentTextLines(lineGroups);
  const neutralBubbles = requireClosedBubbleOutline ? findNeutralBubbleAreas(data, width, height) : undefined;
  const accepted = uniqueRegions(bubbleGroups.filter((group) => {
    const validTextShape = group.width >= 18 && group.width <= 620 && group.height >= 10 && group.height <= 220 && group.width / group.height >= 0.45;
    const eligibleBackdrop = likelySmoothLightBubble(group) || (includeSmoothColourBubbles && hasSmoothBubbleBackdrop(data, width, height, group));
    const insideNeutralBubble = neutralBubbles && isInsideNeutralBubble(group, neutralBubbles.areas, neutralBubbles.labels, width, height);
    const hasClosedOutline = hasLikelyClosedBubbleOutline(data, width, height, group);
    return validTextShape && (eligibleBackdrop || Boolean(insideNeutralBubble)) && (!requireClosedBubbleOutline || (Boolean(insideNeutralBubble) && hasClosedOutline));
  }), maximumRegions);
  return accepted;
}

export function parseQwenBubbleRegions(raw: string, width: number, height: number, maximumRegions = 12): BubbleTextRegion[] {
  for (const candidate of jsonCandidates(raw)) {
    try {
      const parsed = JSON.parse(candidate) as QwenDetectionResponse;
      if (!Array.isArray(parsed.regions)) continue;
      return uniqueRegions(parsed.regions.flatMap((region) => {
        if (region.kind && region.kind !== "dialogue" && region.kind !== "caption") return [];
        if (!Array.isArray(region.bbox_2d) || region.bbox_2d.length !== 4 || !region.bbox_2d.every((value) => typeof value === "number" && Number.isFinite(value))) return [];
        const [ymin, xmin, ymax, xmax] = region.bbox_2d as number[];
        const left = clamp(Math.round(xmin), 0, width - 1); const top = clamp(Math.round(ymin), 0, height - 1);
        const right = clamp(Math.round(xmax), left + 1, width); const bottom = clamp(Math.round(ymax), top + 1, height);
        return right - left < 8 || bottom - top < 8 ? [] : [{ x: left, y: top, width: right - left, height: bottom - top }];
      }), maximumRegions);
    } catch { /* The model may include prose before its JSON. */ }
  }
  return [];
}

async function detectBubbleTextRegions(imageBuffer: Buffer, width: number, height: number, requestTimeoutMs: number, maximumRegions: number) {
  const apiKey = process.env.EXTERNAL_OPENAI_API_KEY || process.env.OPENAI_API_KEY;
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
        { type: "image_url", image_url: { url: `data:image/jpeg;base64,${imageBuffer.toString("base64")}` } },
      ] }],
    }),
  };
  for (let contentAttempt = 0; contentAttempt < 1; contentAttempt += 1) {
    let response: Response | undefined;
    let networkError: unknown;
    for (let attempt = 0; attempt < 1; attempt += 1) {
      try { response = await fetch(`${EXTERNAL_QWEN_BASE_URL}/chat/completions`, { ...request, signal: AbortSignal.timeout(requestTimeoutMs) }); break; }
      catch (error) { networkError = error; }
    }
    if (!response) throw new Error(`انتهت مهلة موفر كشف النص بعد ${Math.round(requestTimeoutMs / 1000)} ثانية: ${networkError instanceof Error ? networkError.message : "خطأ شبكة"}`);
    const body = await response.text();
    if (!response.ok) throw new Error(`تعذر كشف النص عبر الموفر الخارجي (${response.status}): ${body.slice(0, 240)}`);
    try {
      const payload = JSON.parse(body) as { choices?: Array<{ message?: { content?: unknown } }> };
      const content = payload.choices?.[0]?.message?.content;
      if (typeof content !== "string") throw new Error("رد موفر كشف النص لا يحتوي نصًا صالحًا.");
      if (content.trim() === "[Qwen: empty response]") return [];
      return parseQwenBubbleRegions(content, width, height, maximumRegions);
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

function brightness(color: Pixel) { return (color[0] * 0.299) + (color[1] * 0.587) + (color[2] * 0.114); }
function median(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

function inferLightBubbleFill(source: Buffer, width: number, height: number, region: BubbleTextRegion): Pixel | undefined {
  const read = (x: number, y: number): Pixel => { const o = (y * width + x) * 4; return [source[o], source[o + 1], source[o + 2], source[o + 3]]; };
  const pad = 5;
  const x0 = clamp(region.x - pad, 1, width - 2); const y0 = clamp(region.y - pad, 1, height - 2);
  const x1 = clamp(region.x + region.width + pad, x0 + 1, width - 2); const y1 = clamp(region.y + region.height + pad, y0 + 1, height - 2);
  const samples: Pixel[] = [];
  for (let x = x0; x <= x1; x += 2) { samples.push(read(x, y0), read(x, y1)); }
  for (let y = y0 + 2; y < y1; y += 2) { samples.push(read(x0, y), read(x1, y)); }
  const light = samples.filter((color) => color[3] > 220 && brightness(color) >= 230 && Math.max(color[0], color[1], color[2]) - Math.min(color[0], color[1], color[2]) <= 42);
  if (light.length < Math.max(10, Math.floor(samples.length * 0.3))) return undefined;
  return [median(light.map((color) => color[0])), median(light.map((color) => color[1])), median(light.map((color) => color[2])), 255];
}

export function hasNeutralLightBubbleInterior(source: Buffer, width: number, height: number, region: BubbleTextRegion) {
  let light = 0; let samples = 0;
  const insetX = Math.max(2, Math.round(region.width * 0.08)); const insetY = Math.max(2, Math.round(region.height * 0.08));
  for (let y = region.y + insetY; y < region.y + region.height - insetY; y += 4) for (let x = region.x + insetX; x < region.x + region.width - insetX; x += 4) {
    const offset = (clamp(y, 0, height - 1) * width + clamp(x, 0, width - 1)) * 4;
    const red = source[offset]; const green = source[offset + 1]; const blue = source[offset + 2];
    const neutral = Math.max(red, green, blue) - Math.min(red, green, blue) <= 70;
    if (source[offset + 3] > 220 && brightness([red, green, blue, source[offset + 3]]) >= 238 && Math.max(red, green, blue) - Math.min(red, green, blue) <= 26 && neutral) light += 1;
    samples += 1;
  }
  return samples >= 8 && light / samples >= 0.52;
}

export function isLikelyQrTextCluster(region: BubbleTextRegion & { confidence: number }) {
  const aspectRatio = region.width / Math.max(1, region.height);
  return region.confidence < 0.60 && aspectRatio >= 0.72 && aspectRatio <= 1.38 && region.width >= 80 && region.height >= 80;
}

/**
 * The learned model is helpful where a simple fill would damage a coloured or
 * dark bubble. Neutral white dialogue balloons are deliberately kept on the
 * local path: it is faster and does not leave the faint learned-model haze
 * observed on otherwise flat white paper.
 */
export function shouldUseLocalBubbleRepair(source: Buffer, width: number, height: number, region: BubbleTextRegion) {
  const fill = inferLightBubbleFill(source, width, height, region) ?? (hasNeutralLightBubbleInterior(source, width, height, region) ? [246, 246, 246, 255] as Pixel : undefined);
  if (!fill) return false;
  const chroma = Math.max(fill[0], fill[1], fill[2]) - Math.min(fill[0], fill[1], fill[2]);
  return brightness(fill) >= 205 && chroma <= 32;
}

export function inpaintDetectedTextBoxes(source: Buffer, width: number, height: number, regions: BubbleTextRegion[], detectorTextMask?: Buffer) {
  const output = Buffer.from(source);
  const read = (x: number, y: number): Pixel => { const o = (y * width + x) * 4; return [source[o], source[o + 1], source[o + 2], source[o + 3]]; };
  const write = (x: number, y: number, c: Pixel) => { const o = (y * width + x) * 4; output[o] = Math.round(c[0]); output[o + 1] = Math.round(c[1]); output[o + 2] = Math.round(c[2]); output[o + 3] = source[o + 3]; };
  const averageAt = (x: number, y: number, direction: "x" | "y"): Pixel => {
    const samples: Pixel[] = []; for (let offset = -2; offset <= 2; offset += 1) samples.push(direction === "x" ? read(clamp(x + offset, 0, width - 1), y) : read(x, clamp(y + offset, 0, height - 1)));
    return [samples.reduce((sum, c) => sum + c[0], 0) / 5, samples.reduce((sum, c) => sum + c[1], 0) / 5, samples.reduce((sum, c) => sum + c[2], 0) / 5, 255];
  };
  const detectorMaskAvailable = detectorTextMask?.length === width * height;
  for (const region of uniqueRegions(regions, 48)) {
    const lightFill = inferLightBubbleFill(source, width, height, region);
    const fill: Pixel = lightFill ?? [246, 246, 246, 255];
    const smooth = !lightFill && hasSmoothBubbleBackdrop(source, width, height, region);
    if (!lightFill && !smooth) continue;
    const layerPadding = lightFill ? clamp(Math.round(Math.min(region.width, region.height) * 0.12), 6, 16) : clamp(Math.round(Math.min(region.width, region.height) * 0.14), 7, 14);
    const x0 = clamp(region.x - layerPadding, 6, width - 7); const y0 = clamp(region.y - layerPadding, 6, height - 7); const x1 = clamp(region.x + region.width + layerPadding, x0 + 1, width - 7); const y1 = clamp(region.y + region.height + layerPadding, y0 + 1, height - 7);
    const backdropAt = (x: number, y: number) => {
      const horizontal = mix(averageAt(x0 - 4, y, "y"), averageAt(x1 + 4, y, "y"), (x - x0) / Math.max(1, x1 - x0));
      // A constant white fill creates a visible rectangle on the subtle grey gradient
      // inside large balloons. Blend the inferred fill with nearby pixels instead.
      return lightFill ? mix(horizontal, lightFill, 0.28) : horizontal;
    };
    const boxWidth = x1 - x0 + 1; const boxHeight = y1 - y0 + 1; const mask = new Uint8Array(boxWidth * boxHeight);
    for (let y = y0 + 1; y < y1; y += 1) for (let x = x0 + 1; x < x1; x += 1) {
      const expected = backdropAt(x, y);
      const pixel = read(x, y);
      const detectorPixel = detectorMaskAvailable && detectorTextMask![y * width + x] > 0;
      // For local balloon repair, the learned segmentation is the safety boundary.
      // Do not infer extra pixels: that can erase the balloon outline or a nearby face.
      if (detectorMaskAvailable && !detectorPixel && !lightFill) continue;
      const isContrasting = colorDistance(pixel, expected) > (lightFill ? 6 : 50);
      if (lightFill) {
        let whiteNeighbours = 0;
        for (let dy = -2; dy <= 2; dy += 1) for (let dx = -2; dx <= 2; dx += 1) {
          if (!dx && !dy) continue;
          const neighbour = read(clamp(x + dx, 0, width - 1), clamp(y + dy, 0, height - 1));
          const neighbourChroma = Math.max(neighbour[0], neighbour[1], neighbour[2]) - Math.min(neighbour[0], neighbour[1], neighbour[2]);
          if (brightness(neighbour) >= 222 && neighbourChroma <= 58) whiteNeighbours += 1;
        }
        if (whiteNeighbours < 5 || !isContrasting) continue;
        mask[(y - y0) * boxWidth + x - x0] = 1;
        continue;
      }
      if (!isContrasting) continue;
      let backgroundNeighbours = 0;
      for (const [dx, dy] of [[-3, 0], [3, 0], [0, -3], [0, 3], [-3, -3], [3, -3], [-3, 3], [3, 3]]) {
        if (colorDistance(read(clamp(x + dx, 0, width - 1), clamp(y + dy, 0, height - 1)), backdropAt(clamp(x + dx, x0, x1), clamp(y + dy, y0, y1))) < (lightFill ? 62 : 56)) backgroundNeighbours += 1;
      }
      if (backgroundNeighbours >= 5) mask[(y - y0) * boxWidth + x - x0] = 1;
    }
    const expanded = new Uint8Array(mask);
    for (let pass = 0; pass < (detectorMaskAvailable ? 0 : lightFill ? 5 : 2); pass += 1) { const next = new Uint8Array(expanded); for (let y = 1; y < boxHeight - 1; y += 1) for (let x = 1; x < boxWidth - 1; x += 1) if (expanded[y * boxWidth + x]) for (let dy = -1; dy <= 1; dy += 1) for (let dx = -1; dx <= 1; dx += 1) next[(y + dy) * boxWidth + x + dx] = 1; expanded.set(next); }
    for (let y = y0; y <= y1; y += 1) for (let x = x0; x <= x1; x += 1) if (expanded[(y - y0) * boxWidth + x - x0]) write(x, y, lightFill ? fill : backdropAt(x, y));
  }
  return output;
}

function regionBackground(source: Buffer, width: number, height: number, region: BubbleTextRegion): Pixel {
  const read = (x: number, y: number): Pixel => { const o = (clamp(y, 0, height - 1) * width + clamp(x, 0, width - 1)) * 4; return [source[o], source[o + 1], source[o + 2], source[o + 3]]; };
  const samples: Pixel[] = [];
  const x0 = clamp(region.x - 3, 0, width - 1); const x1 = clamp(region.x + region.width + 3, 0, width - 1);
  const y0 = clamp(region.y - 3, 0, height - 1); const y1 = clamp(region.y + region.height + 3, 0, height - 1);
  for (let x = x0; x <= x1; x += 3) samples.push(read(x, y0), read(x, y1));
  for (let y = y0; y <= y1; y += 3) samples.push(read(x0, y), read(x1, y));
  return [median(samples.map((color) => color[0])), median(samples.map((color) => color[1])), median(samples.map((color) => color[2])), 255];
}

function expandBinaryMask(mask: Uint8Array, width: number, height: number, passes: number) {
  let current = mask;
  for (let pass = 0; pass < passes; pass += 1) {
    const next = new Uint8Array(current);
    for (let y = 1; y < height - 1; y += 1) for (let x = 1; x < width - 1; x += 1) if (current[y * width + x]) {
      for (let dy = -1; dy <= 1; dy += 1) for (let dx = -1; dx <= 1; dx += 1) next[(y + dy) * width + x + dx] = 255;
    }
    current = next;
  }
  return current;
}

export function buildTrainedInpaintMask(source: Buffer, width: number, height: number, regions: BubbleTextRegion[], detectorTextMask?: Buffer) {
  const mask = new Uint8Array(width * height);
  const read = (x: number, y: number): Pixel => { const o = (y * width + x) * 4; return [source[o], source[o + 1], source[o + 2], source[o + 3]]; };
  const detectorMaskAvailable = detectorTextMask?.length === width * height;
  for (const region of uniqueRegions(regions, 48)) {
    const background = regionBackground(source, width, height, region);
    const x0 = clamp(region.x, 1, width - 2); const y0 = clamp(region.y, 1, height - 2);
    const x1 = clamp(region.x + region.width, x0 + 1, width - 2); const y1 = clamp(region.y + region.height, y0 + 1, height - 2);
    for (let y = y0; y < y1; y += 1) for (let x = x0; x < x1; x += 1) {
      const pixel = read(x, y);
      const brightDifference = Math.abs(brightness(pixel) - brightness(background));
      const segmentedText = detectorMaskAvailable && detectorTextMask![y * width + x] > 0;
      const contrastsWithBackdrop = pixel[3] > 180 && (colorDistance(pixel, background) > 48 || brightDifference > 38);
      // When ONNX supplies a mask, never let a broad box erase a nearby face or artwork.
      // Without it, retain the conservative contrast fallback for remote/manual regions.
      const likelyTextEdge = segmentedText && pixel[3] > 180 && (colorDistance(pixel, background) > 12 || brightDifference > 10);
      if ((detectorMaskAvailable ? likelyTextEdge : contrastsWithBackdrop) && pixel[3] > 180) mask[y * width + x] = 255;
    }
  }
  return expandBinaryMask(mask, width, height, detectorMaskAvailable ? 1 : 3);
}

function cropRaw(source: Buffer, pageWidth: number, pageHeight: number, left: number, top: number, cropWidth: number, cropHeight: number) {
  const output = Buffer.alloc(cropWidth * cropHeight * 4); const rowBytes = pageWidth * 4;
  for (let row = 0; row < cropHeight; row += 1) source.copy(output, row * cropWidth * 4, (top + row) * rowBytes + left * 4, (top + row) * rowBytes + (left + cropWidth) * 4);
  return output;
}

async function inpaintWithTrainedModel(source: Buffer, width: number, height: number, regions: BubbleTextRegion[], detectorTextMask?: Buffer) {
  let output = Buffer.from(source); const globalMask = buildTrainedInpaintMask(source, width, height, regions, detectorTextMask); let repairedRegions = 0;
  for (const region of uniqueRegions(regions, 48)) {
    const padding = clamp(Math.round(Math.max(region.width, region.height) * 0.35), 32, 128);
    const left = clamp(region.x - padding, 0, width - 1); const top = clamp(region.y - padding, 0, height - 1);
    const right = clamp(region.x + region.width + padding, left + 1, width); const bottom = clamp(region.y + region.height + padding, top + 1, height);
    const cropWidth = right - left; const cropHeight = bottom - top; const cropMask = Buffer.alloc(cropWidth * cropHeight);
    let hasMask = false;
    for (let y = 0; y < cropHeight; y += 1) { cropMask.set(globalMask.subarray((top + y) * width + left, (top + y) * width + right), y * cropWidth); hasMask ||= cropMask.subarray(y * cropWidth, (y + 1) * cropWidth).some((value) => value > 0); }
    if (!hasMask) continue;
    const cropImage = await sharp(cropRaw(output, width, height, left, top, cropWidth, cropHeight), { raw: { width: cropWidth, height: cropHeight, channels: 4 } }).png().toBuffer();
    const maskImage = await sharp(cropMask, { raw: { width: cropWidth, height: cropHeight, channels: 1 } }).png().toBuffer();
    const trained = await requestTrainedInpainting(cropImage, maskImage); if (!trained) continue;
    const trainedMetadata = await sharp(trained.image).metadata();
    if (trainedMetadata.width !== cropWidth || trainedMetadata.height !== cropHeight) {
      console.warn("[cleaner] discarded trained crop with unexpected dimensions", { expected: `${cropWidth}x${cropHeight}`, received: `${trainedMetadata.width ?? 0}x${trainedMetadata.height ?? 0}` });
      continue;
    }
    const repaired = await sharp(trained.image).ensureAlpha().raw().toBuffer();
    if (repaired.length !== cropWidth * cropHeight * 4) {
      console.warn("[cleaner] discarded trained crop with unexpected raw byte length");
      continue;
    }
    for (let y = 0; y < cropHeight; y += 1) for (let x = 0; x < cropWidth; x += 1) if (cropMask[y * cropWidth + x]) repaired.copy(output, ((top + y) * width + left + x) * 4, (y * cropWidth + x) * 4, (y * cropWidth + x + 1) * 4);
    repairedRegions += 1;
  }
  return { output, repairedRegions };
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
  const profile = cleaningProfileFor(input.quality);
  const decoded = await sharp(input.image).ensureAlpha().raw().toBuffer();
  const output = Buffer.from(decoded);
  const rowBytes = width * 4;
  const tileCount = Math.ceil(height / profile.tileHeight); let detectedRegions = 0; let remoteDetectionTiles = 0; let trainedInpaintRegions = 0; let remoteDetectionUnavailable = false;
  for (let tileIndex = 0; tileIndex < tileCount; tileIndex += 1) {
    const coreTop = tileIndex * profile.tileHeight; const coreHeight = Math.min(profile.tileHeight, height - coreTop);
    const top = Math.max(0, coreTop - TILE_OVERLAP); const bottom = Math.min(height, coreTop + coreHeight + TILE_OVERLAP); const currentHeight = bottom - top;
    const tileData = Buffer.from(decoded.subarray(top * rowBytes, bottom * rowBytes));
    // Detection only: JPEG significantly reduces the remote request size while preserving tile coordinates.
    const visionInput = await sharp(tileData, { raw: { width, height: currentHeight, channels: 4 } }).jpeg({ quality: 92, chromaSubsampling: "4:4:4" }).toBuffer();
    await input.onTile?.({ tileIndex, tileCount, status: "detecting" });
    // The fallback also considers smooth coloured/gradient balloons. The learned detector remains the
    // primary source and is not gated by a white-background heuristic.
    const local = await detectFallbackDarkTextRegions(visionInput, width, currentHeight, true, profile.maxRegionsPerTile, false);
    // Always run the local ONNX detector. Speed mode previously skipped it and
    // relied only on the dark-ink fallback, which can collapse a long-strip page
    // to a single detected balloon. Big-LaMa remains disabled in speed mode.
    const comicDetection = await requestLocalComicTextDetectionWithMask(visionInput);
    const comicRegions = comicDetection?.regions;
    const comicNeutralBubbles = comicRegions?.length ? findNeutralBubbleAreas(tileData, width, currentHeight) : undefined;
    const comicBubbleRegions = (comicRegions ?? []).flatMap(({ confidence, ...region }) => {
      const valid = region.x >= 0 && region.y >= 0 && region.x + region.width <= width && region.y + region.height <= currentHeight;
      const insideNeutralBubble = comicNeutralBubbles && isInsideNeutralBubble(region, comicNeutralBubbles.areas, comicNeutralBubbles.labels, width, currentHeight);
      const hasNeutralInterior = Boolean(insideNeutralBubble) || hasNeutralLightBubbleInterior(tileData, width, currentHeight, region);
      const smoothBubbleFill = hasSmoothBubbleBackdrop(tileData, width, currentHeight, region);
      const closedOutline = hasLikelyClosedBubbleOutline(tileData, width, currentHeight, region);
      // The retained full-page test exposed a QR card as a low-confidence, nearly square white "bubble".
      // A genuine dialogue block may be square, but the detector assigns it materially higher confidence on these pages.
      const likelyQrCode = isLikelyQrTextCluster({ ...region, confidence });
      // ONNX is a text detector, not a bubble-colour classifier. Trust valid detector boxes for
      // white, coloured, gradient and semi-transparent balloons alike; only suppress the known
      // low-confidence square QR false positive.
      if (!valid || likelyQrCode) return [];
      // Keep a connected/overlapping balloon as one semantic region. The detector mask
      // below separates its text lines without drawing an artificial rectangle through it.
      return [region];
    });
    const remote = profile.useRemoteWhenLocalMisses && (comicRegions === undefined || profile.useRemoteAlongsideLocal) && !remoteDetectionUnavailable
      ? await detectBubbleTextRegions(visionInput, width, currentHeight, profile.requestTimeoutMs, profile.maxRegionsPerTile).catch((error) => {
        console.warn("[cleaner] remote detection skipped for one tile", error instanceof Error ? error.message : error);
        remoteDetectionUnavailable = true;
        return [] as BubbleTextRegion[];
      })
      : [];
    if (remote.length) remoteDetectionTiles += 1;
    const detected = remote.length
      ? uniqueRegions([...remote, ...comicBubbleRegions, ...local], profile.maxRegionsPerTile)
      : comicBubbleRegions.length ? uniqueRegions([...comicBubbleRegions, ...local], profile.maxRegionsPerTile)
        : uniqueRegions(local, profile.maxRegionsPerTile); detectedRegions += detected.length;
    const regions = uniqueRegions([...detected, ...manualRegionsForTile(input.maskAdjustments, width, height, top, currentHeight)], 48);
    await input.onTile?.({ tileIndex, tileCount, status: "cleaning" });
    // Keep flat white balloons on the deterministic local path even in maximum-detail.
    // If the learned detector/inpainting service is unavailable, this still produces a useful result.
    const localRegions = !profile.useTrainedInpainting ? regions : regions.filter((region) => shouldUseLocalBubbleRepair(tileData, width, currentHeight, region));
    const trainedRegions = profile.useTrainedInpainting ? regions.filter((region) => !shouldUseLocalBubbleRepair(tileData, width, currentHeight, region)) : [];
    const trained = trainedRegions.length ? await inpaintWithTrainedModel(tileData, width, currentHeight, trainedRegions, comicDetection?.textMask) : undefined;
    const trainedOutput = trained?.repairedRegions ? trained.output : tileData;
    const repairedRaw = inpaintDetectedTextBoxes(trainedOutput, width, currentHeight, localRegions, comicDetection?.textMask);
    trainedInpaintRegions += trained?.repairedRegions ?? 0;
    const sourceStart = (coreTop - top) * rowBytes;
    repairedRaw.copy(output, coreTop * rowBytes, sourceStart, sourceStart + coreHeight * rowBytes);
  }
  const image = await sharp(output, { raw: { width, height, channels: 4 } }).png({ compressionLevel: 6, adaptiveFiltering: true }).toBuffer();
  const outputMetadata = await sharp(image).metadata();
  if (outputMetadata.width !== width || outputMetadata.height !== height) throw new Error("فشل التحقق من أبعاد الصورة الناتجة؛ لم تُرسل نتيجة غير مطابقة للمصدر.");
  return { image, width, height, tileCount, detectedRegions, remoteDetectionTiles, trainedInpaintRegions };
}
