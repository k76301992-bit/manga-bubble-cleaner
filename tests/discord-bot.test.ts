import JSZip from "jszip";
import { describe, expect, it, vi } from "vitest";
import { isDiscordZipAttachment, originalDiscordAttachmentUrl, sourceFromDiscordAttachments, validateDiscordImageAttachment, validateDiscordZipAttachment } from "../server/standalone/discord-bot";

describe("Discord image intake", () => {
  it("accepts an HTTPS PNG below the memory-only processing limit", () => {
    expect(validateDiscordImageAttachment({ url: "https://cdn.discordapp.com/attachments/1/2/page.png", name: "page.png", size: 1024, contentType: "image/png" } as never)).toBeUndefined();
  });

  it("removes media-proxy resize parameters while preserving the original Discord attachment path", () => {
    expect(originalDiscordAttachmentUrl("https://media.discordapp.net/attachments/1/2/page.png?width=178&height=3837&ex=abc&is=def&hm=123")).toBe("https://cdn.discordapp.com/attachments/1/2/page.png?ex=abc&is=def&hm=123");
  });

  it("recognizes ZIP uploads from their filename or Discord MIME type", () => {
    const fromName = { url: "https://cdn.discordapp.com/attachments/1/2/chapter.zip", name: "chapter.zip", size: 1024, contentType: "application/octet-stream" } as never;
    const fromMime = { url: "https://cdn.discordapp.com/attachments/1/2/chapter", name: "chapter", size: 1024, contentType: "application/zip" } as never;
    expect(isDiscordZipAttachment(fromName)).toBe(true);
    expect(isDiscordZipAttachment(fromMime)).toBe(true);
    expect(validateDiscordZipAttachment(fromMime)).toBeUndefined();
  });

  it("routes a MIME-declared Discord ZIP into the batch extractor", async () => {
    const zip = new JSZip();
    zip.file("chapter/01.jpg", Buffer.from([1, 2, 3]));
    zip.file("chapter/02.webp", Buffer.from([4, 5, 6]));
    const archive = await zip.generateAsync({ type: "nodebuffer" });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(Uint8Array.from(archive)));
    try {
      const source = await sourceFromDiscordAttachments([{ url: "https://cdn.discordapp.com/attachments/1/2/chapter", name: "chapter", size: archive.length, contentType: "application/zip" } as never]);
      expect(source.kind).toBe("zip");
      expect(source.images.map((image) => image.name)).toEqual(["01.jpg", "02.webp"]);
      expect(fetchMock).toHaveBeenCalledOnce();
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("rejects non-image, insecure, and oversized attachments before downloading them", () => {
    expect(validateDiscordImageAttachment({ url: "https://cdn.discordapp.com/attachments/1/2/page.txt", name: "page.txt", size: 10, contentType: "text/plain" } as never)).toContain("PNG");
    expect(validateDiscordImageAttachment({ url: "http://cdn.discordapp.com/attachments/1/2/page.png", name: "page.png", size: 10, contentType: "image/png" } as never)).toContain("HTTPS");
    expect(validateDiscordImageAttachment({ url: "https://example.com/page.png", name: "page.png", size: 10, contentType: "image/png" } as never)).toContain("Discord");
    expect(validateDiscordImageAttachment({ url: "https://cdn.discordapp.com/attachments/1/2/page.webp", name: "page.webp", size: 21 * 1024 * 1024, contentType: "image/webp" } as never)).toContain("20");
  });
});
