import { describe, expect, it } from "vitest";

import { normalizeCleanerSettings } from "../lib/cleaner-settings";
import { buildCleaningPrompt, decodeImageDataUrl, ensurePublicImageUrl } from "../server/manga-bubble-cleaner";

describe("manga bubble cleanup safeguards", () => {
  it("builds a high-detail prompt that preserves artwork and limits edits to dialogue text", () => {
    const prompt = buildCleaningPrompt("maximum-detail");

    expect(prompt).toContain("Remove only visible dialogue lettering");
    expect(prompt).toContain("Preserve every original non-text stroke");
    expect(prompt).toContain("Do not redraw, restyle, recolor");
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
});
