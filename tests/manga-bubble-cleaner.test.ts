import { describe, expect, it } from "vitest";

import { normalizeCleanerSettings } from "../lib/cleaner-settings";
import { buildCleaningPrompt, decodeImageDataUrl, ensurePublicImageUrl, inpaintDetectedTextBoxes } from "../server/manga-bubble-cleaner";

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

  it("rebuilds only high-contrast letter pixels from surrounding bubble colors", () => {
    const source = Buffer.alloc(25 * 25 * 4, 255);
    for (let index = 0; index < 25 * 25; index += 1) { source[index * 4] = 210; source[index * 4 + 1] = 80; source[index * 4 + 2] = 40; }
    const center = (12 * 25 + 12) * 4;
    source[center] = 0; source[center + 1] = 0; source[center + 2] = 0;
    const repaired = inpaintDetectedTextBoxes(source, 25, 25, [{ x: 12, y: 12, width: 1, height: 1 }]);
    expect(repaired[center]).toBeGreaterThan(150);
    expect(repaired[0]).toBe(210);
  });
});
