import { describe, expect, it } from "vitest";
import { validateDiscordImageAttachment } from "../server/standalone/discord-bot";

describe("Discord image intake", () => {
  it("accepts an HTTPS PNG below the memory-only processing limit", () => {
    expect(validateDiscordImageAttachment({ url: "https://cdn.discordapp.com/attachments/1/2/page.png", name: "page.png", size: 1024, contentType: "image/png" } as never)).toBeUndefined();
  });

  it("rejects non-image, insecure, and oversized attachments before downloading them", () => {
    expect(validateDiscordImageAttachment({ url: "https://cdn.discordapp.com/attachments/1/2/page.txt", name: "page.txt", size: 10, contentType: "text/plain" } as never)).toContain("PNG");
    expect(validateDiscordImageAttachment({ url: "http://cdn.discordapp.com/attachments/1/2/page.png", name: "page.png", size: 10, contentType: "image/png" } as never)).toContain("HTTPS");
    expect(validateDiscordImageAttachment({ url: "https://example.com/page.png", name: "page.png", size: 10, contentType: "image/png" } as never)).toContain("Discord");
    expect(validateDiscordImageAttachment({ url: "https://cdn.discordapp.com/attachments/1/2/page.webp", name: "page.webp", size: 21 * 1024 * 1024, contentType: "image/webp" } as never)).toContain("20");
  });
});
