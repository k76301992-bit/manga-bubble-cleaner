import { describe, expect, it } from "vitest";

import { normalizeCleanerSettings } from "../lib/cleaner-settings";
import { buildCleaningPrompt, decodeImageDataUrl, ensurePublicImageUrl, hasSmoothBubbleBackdrop, inpaintDetectedTextBoxes, manualRegionsForTile } from "../server/manga-bubble-cleaner";

describe("manga bubble cleanup safeguards", () => {
  it("builds a high-detail prompt that preserves artwork and limits edits to dialogue text", () => {
    const prompt = buildCleaningPrompt("maximum-detail");

    expect(prompt).toContain("Remove only visible dialogue lettering");
    expect(prompt).toContain("Preserve all non-text artwork");
    expect(prompt).toContain("Do not whiten colored bubbles");
  });

  it("accepts a supported image data URL", () => {
    const result = decodeImageDataUrl("data:image/png;base64,aGVsbG8=");

    expect(result.mimeType).toBe("image/png");
    expect(result.buffer.toString("utf8")).toBe("hello");
  });

  it("rejects unsupported image types before any image operation begins", () => {
    expect(() => decodeImageDataUrl("data:image/gif;base64,aGVsbG8=")).toThrow(
      "يقبل التطبيق صور PNG أو JPG أو WebP فقط.",
    );
  });

  it("normalizes incomplete local settings without weakening the quality default", () => {
    expect(normalizeCleanerSettings({ defaultQualityPreset: "invalid", keepOriginalDimensions: false })).toEqual({
      defaultQualityPreset: "preserve-detail",
      defaultExportFormat: "png",
      keepOriginalDimensions: false,
      saveResultsToGallery: false,
    });
  });

  it("accepts public HTTPS image URLs but blocks local network destinations", () => {
    expect(ensurePublicImageUrl("https://cdn.example.com/page.webp").hostname).toBe("cdn.example.com");
    expect(() => ensurePublicImageUrl("http://127.0.0.1:3000/private.png")).toThrow("يجب أن يكون الرابط عامًا وآمنًا.");
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
    const untouched = (2 * 49 + 2) * 4;
    expect(repaired[center]).toBeLessThan(160);
    expect(repaired[center + 1]).toBeLessThan(80);
    expect(repaired[untouched]).toBe(source[untouched]);
  });

  it("maps a manual include region to its intersecting tile only", () => {
    const adjustment = [{ mode: "include" as const, points: [{ x: 0.2, y: 0.55 }, { x: 0.6, y: 0.65 }] }];
    expect(manualRegionsForTile(adjustment, 1000, 10_000, 0, 2400)).toEqual([]);
    expect(manualRegionsForTile(adjustment, 1000, 10_000, 4800, 2400)).toEqual([{ x: 200, y: 700, width: 400, height: 1000 }]);
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
});
