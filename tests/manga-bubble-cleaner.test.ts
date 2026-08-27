import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { normalizeCleanerSettings } from "../lib/cleaner-settings";
import { cleanImageInMemory, cleaningProfileFor, detectFallbackDarkTextRegions, hasLikelyClosedBubbleOutline, hasNeutralLightBubbleInterior, hasSmoothBubbleBackdrop, inpaintDetectedTextBoxes, isLikelyQrTextCluster, manualRegionsForTile, mergeAdjacentTextLines, parseQwenBubbleRegions, shouldUseLocalBubbleRepair } from "../server/standalone/cleaner";

describe("manga bubble cleanup safeguards", () => {
  it("normalizes incomplete local settings without weakening the quality default", () => {
    expect(normalizeCleanerSettings({ defaultQualityPreset: "invalid", keepOriginalDimensions: false })).toEqual({
      defaultQualityPreset: "preserve-detail",
      defaultExportFormat: "png",
      keepOriginalDimensions: false,
      saveResultsToGallery: false,
    });
  });

  it("rebuilds a letter mask from a colored bubble backdrop while preserving pixels outside the region", () => {
    const source = Buffer.alloc(25 * 25 * 4, 255);
    for (let index = 0; index < 25 * 25; index += 1) { source[index * 4] = 210; source[index * 4 + 1] = 80; source[index * 4 + 2] = 40; }
    const center = (12 * 25 + 12) * 4;
    source[center] = 0; source[center + 1] = 0; source[center + 2] = 0;
    const repaired = inpaintDetectedTextBoxes(source, 25, 25, [{ x: 12, y: 12, width: 1, height: 1 }]);
    expect(repaired[center]).toBeGreaterThan(150);
    expect(repaired[0]).toBe(210);
  });

  it("removes white dialogue marks over a dark-to-red bubble gradient without flattening the fill", () => {
    const source = Buffer.alloc(49 * 49 * 4, 255);
    for (let y = 0; y < 49; y += 1) for (let x = 0; x < 49; x += 1) {
      const offset = (y * 49 + x) * 4;
      source[offset] = 18 + y * 3;
      source[offset + 1] = 8 + Math.floor(x / 10);
      source[offset + 2] = 10 + y;
    }
    for (let y = 23; y <= 27; y += 1) for (let x = 21; x <= 27; x += 1) {
      const offset = (y * 49 + x) * 4;
      source[offset] = 255; source[offset + 1] = 255; source[offset + 2] = 255;
    }
    const repaired = inpaintDetectedTextBoxes(source, 49, 49, [{ x: 20, y: 22, width: 9, height: 7 }]);
    const center = (25 * 49 + 24) * 4;
    const clearBackdrop = (19 * 49 + 18) * 4;
    const untouched = (2 * 49 + 2) * 4;
    expect(repaired[center]).toBeLessThan(160);
    expect(repaired[center + 1]).toBeLessThan(80);
    expect(Math.abs(repaired[clearBackdrop] - source[clearBackdrop])).toBeLessThan(16);
    expect(repaired[untouched]).toBe(source[untouched]);
  });

  it("cleans compact dark glyphs inside a light bubble without painting over its dark border", () => {
    const source = Buffer.alloc(120 * 100 * 4, 255);
    for (let y = 0; y < 100; y += 1) for (let x = 0; x < 120; x += 1) {
      const offset = (y * 120 + x) * 4;
      if (x === 18 || x === 101 || y === 18 || y === 81) source[offset] = source[offset + 1] = source[offset + 2] = 0;
    }
    for (const glyphX of [49, 58, 67]) for (let y = 43; y < 54; y += 1) for (let x = glyphX; x < glyphX + 3; x += 1) {
      const offset = (y * 120 + x) * 4; source[offset] = source[offset + 1] = source[offset + 2] = 0;
    }
    const repaired = inpaintDetectedTextBoxes(source, 120, 100, [{ x: 45, y: 40, width: 30, height: 18 }]);
    expect(repaired[(18 * 120 + 60) * 4]).toBeLessThan(25);
    expect(repaired[(48 * 120 + 59) * 4]).toBeGreaterThan(220);
  });

  it("uses materially different speed and detail profiles", () => {
    const fast = cleaningProfileFor("balanced"); const detail = cleaningProfileFor("maximum-detail");
    expect(fast.tileHeight).toBeGreaterThan(detail.tileHeight);
    expect(fast.useRemoteWhenLocalMisses).toBe(false);
    expect(fast.useTrainedInpainting).toBe(false);
    expect(detail.useRemoteWhenLocalMisses).toBe(true);
    expect(detail.useRemoteAlongsideLocal).toBe(true);
    expect(detail.useTrainedInpainting).toBe(true);
    expect(detail.trainedOnly).toBe(true);
    expect(detail.maxRegionsPerTile).toBeGreaterThan(fast.maxRegionsPerTile);
  });

  it("returns a PNG with exactly the input dimensions", async () => {
    const width = 73; const height = 41;
    const source = await sharp({ create: { width, height, channels: 3, background: "#f4f0ef" } }).jpeg().toBuffer();
    const result = await cleanImageInMemory({ image: source, mimeType: "image/jpeg", quality: "balanced" });
    expect({ width: result.width, height: result.height }).toEqual({ width, height });
    await expect(sharp(result.image).metadata()).resolves.toMatchObject({ width, height });
  });

  it("keeps neutral white bubbles on the local repair path and sends coloured bubbles to the trained path", () => {
    const white = Buffer.alloc(80 * 80 * 4, 255);
    const red = Buffer.alloc(80 * 80 * 4, 255);
    for (let pixel = 0; pixel < 80 * 80; pixel += 1) { red[pixel * 4] = 130; red[pixel * 4 + 1] = 28; red[pixel * 4 + 2] = 38; }
    const region = { x: 22, y: 24, width: 28, height: 16 };
    expect(shouldUseLocalBubbleRepair(white, 80, 80, region)).toBe(true);
    expect(shouldUseLocalBubbleRepair(red, 80, 80, region)).toBe(false);
  });

  it("maps a manual include region to its intersecting tile only", () => {
    const adjustment = [{ mode: "include" as const, points: [{ x: 0.2, y: 0.55 }, { x: 0.6, y: 0.65 }] }];
    expect(manualRegionsForTile(adjustment, 1000, 10_000, 0, 2400)).toEqual([]);
    expect(manualRegionsForTile(adjustment, 1000, 10_000, 4800, 2400)).toEqual([{ x: 200, y: 700, width: 400, height: 1000 }]);
  });

  it("extracts qwen pixel boxes from a Markdown-wrapped JSON response", () => {
    const raw = "I found the dialogue.\n```json\n{\"coordinate_space\":\"pixels\",\"regions\":[{\"kind\":\"dialogue\",\"bbox_2d\":[210,318,290,572]}]}\n```";
    expect(parseQwenBubbleRegions(raw, 900, 1100)).toEqual([{ x: 318, y: 210, width: 254, height: 80 }]);
  });

  it("rejects qwen regions that are too small or belong to non-dialogue text", () => {
    const raw = JSON.stringify({ regions: [
      { kind: "sound-effect", bbox_2d: [10, 10, 70, 70] },
      { kind: "dialogue", bbox_2d: [10, 10, 16, 16] },
    ] });
    expect(parseQwenBubbleRegions(raw, 900, 1100)).toEqual([]);
  });

  it("uses whole-box repair for a smooth gradient but rejects a textured artwork ring", () => {
    const smooth = Buffer.alloc(48 * 48 * 4, 255);
    const textured = Buffer.alloc(48 * 48 * 4, 255);
    for (let y = 0; y < 48; y += 1) for (let x = 0; x < 48; x += 1) {
      const offset = (y * 48 + x) * 4;
      smooth[offset] = 80 + y; smooth[offset + 1] = 35 + Math.floor(x / 12); smooth[offset + 2] = 45;
      textured[offset] = x % 2 ? 230 : 15; textured[offset + 1] = 40; textured[offset + 2] = 55;
    }
    const region = { x: 18, y: 18, width: 12, height: 10 };
    expect(hasSmoothBubbleBackdrop(smooth, 48, 48, region)).toBe(true);
    expect(hasSmoothBubbleBackdrop(textured, 48, 48, region)).toBe(false);
  });

  it("recognizes a smooth coloured area enclosed by a dark speech-bubble outline", () => {
    const width = 120; const height = 100; const source = Buffer.alloc(width * height * 4, 255);
    for (let y = 12; y < 88; y += 1) for (let x = 12; x < 108; x += 1) {
      const offset = (y * width + x) * 4;
      source[offset] = 145; source[offset + 1] = 28; source[offset + 2] = 42;
      if (x === 12 || x === 107 || y === 12 || y === 87) source[offset] = source[offset + 1] = source[offset + 2] = 0;
    }
    const region = { x: 43, y: 43, width: 32, height: 14 };
    expect(hasLikelyClosedBubbleOutline(source, width, height, region)).toBe(true);
    expect(hasSmoothBubbleBackdrop(source, width, height, region)).toBe(true);
  });

  it("requires evidence of an enclosing outline before local cleanup touches a light scene", () => {
    const width = 160; const height = 120; const raw = Buffer.alloc(width * height * 4, 248);
    const region = { x: 55, y: 45, width: 50, height: 24 };
    expect(hasLikelyClosedBubbleOutline(raw, width, height, region)).toBe(false);
    for (let x = 30; x <= 130; x += 1) for (const y of [24, 92]) { const offset = (y * width + x) * 4; raw[offset] = raw[offset + 1] = raw[offset + 2] = 12; }
    for (let y = 24; y <= 92; y += 1) for (const x of [30, 130]) { const offset = (y * width + x) * 4; raw[offset] = raw[offset + 1] = raw[offset + 2] = 12; }
    expect(hasLikelyClosedBubbleOutline(raw, width, height, region)).toBe(true);
  });

  it("distinguishes a light bubble interior from light lettering on a dark interface", () => {
    const width = 120; const height = 80; const region = { x: 20, y: 20, width: 80, height: 40 };
    const whiteBubble = Buffer.alloc(width * height * 4, 248);
    expect(hasNeutralLightBubbleInterior(whiteBubble, width, height, region)).toBe(true);
    const darkInterface = Buffer.alloc(width * height * 4, 18);
    for (let y = 29; y < 51; y += 1) for (let x = 40; x < 80; x += 1) { const offset = (y * width + x) * 4; darkInterface[offset] = darkInterface[offset + 1] = darkInterface[offset + 2] = 250; darkInterface[offset + 3] = 255; }
    expect(hasNeutralLightBubbleInterior(darkInterface, width, height, region)).toBe(false);
  });

  it("rejects the low-confidence square QR signature without rejecting a dialogue text box", () => {
    expect(isLikelyQrTextCluster({ x: 92, y: 190, width: 188, height: 180, confidence: 0.455 })).toBe(true);
    expect(isLikelyQrTextCluster({ x: 216, y: 2180, width: 284, height: 220, confidence: 0.733 })).toBe(false);
  });

  it("merges adjacent aligned dialogue lines before bubble validation", () => {
    expect(mergeAdjacentTextLines([
      { x: 45, y: 30, width: 75, height: 15 },
      { x: 50, y: 55, width: 67, height: 16 },
      { x: 52, y: 81, width: 58, height: 15 },
      { x: 150, y: 35, width: 40, height: 15 },
    ])).toEqual([
      { x: 45, y: 30, width: 75, height: 66 },
      { x: 150, y: 35, width: 40, height: 15 },
    ]);
  });

  it("finds a connected dark dialogue line inside a smooth low-saturation bubble when Qwen is unavailable", async () => {
    const width = 200; const height = 100; const raw = Buffer.alloc(width * height * 4, 255);
    for (let pixel = 0; pixel < width * height; pixel += 1) { raw[pixel * 4] = 246; raw[pixel * 4 + 1] = 232; raw[pixel * 4 + 2] = 236; }
    for (let glyph = 0; glyph < 7; glyph += 1) for (let y = 40; y < 60; y += 1) for (let x = 55 + glyph * 13; x < 64 + glyph * 13; x += 1) {
      const offset = (y * width + x) * 4; raw[offset] = 42; raw[offset + 1] = 20; raw[offset + 2] = 24;
    }
    const image = await sharp(raw, { raw: { width, height, channels: 4 } }).png().toBuffer();
    const regions = await detectFallbackDarkTextRegions(image, width, height);
    expect(regions).toHaveLength(1);
    expect(regions[0]).toMatchObject({ x: 55, y: 40, width: 87, height: 20 });
  });

  it("can include dark dialogue over a smooth coloured backdrop only when detailed repair is enabled", async () => {
    const width = 200; const height = 100; const raw = Buffer.alloc(width * height * 4, 255);
    for (let pixel = 0; pixel < width * height; pixel += 1) { raw[pixel * 4] = 126; raw[pixel * 4 + 1] = 38; raw[pixel * 4 + 2] = 52; }
    for (let glyph = 0; glyph < 7; glyph += 1) for (let y = 40; y < 60; y += 1) for (let x = 55 + glyph * 13; x < 64 + glyph * 13; x += 1) {
      const offset = (y * width + x) * 4; raw[offset] = 18; raw[offset + 1] = 12; raw[offset + 2] = 14;
    }
    const image = await sharp(raw, { raw: { width, height, channels: 4 } }).png().toBuffer();
    await expect(detectFallbackDarkTextRegions(image, width, height)).resolves.toEqual([]);
    await expect(detectFallbackDarkTextRegions(image, width, height, true)).resolves.toHaveLength(1);
  });
});
