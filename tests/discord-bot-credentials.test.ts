import { describe, expect, it } from "vitest";
import { isDiscordBotEnabled } from "../server/standalone/discord-bot";

describe("Discord bot credentials", () => {
  it("authenticates the configured bot token against the current bot user endpoint", async () => {
    const token = process.env.DISCORD_BOT_TOKEN?.trim();
    expect(token, "DISCORD_BOT_TOKEN must be configured").toBeTruthy();
    const response = await fetch("https://discord.com/api/v10/users/@me", {
      headers: { Authorization: `Bot ${token}` },
      signal: AbortSignal.timeout(15_000),
    });
    expect(response.status).toBe(200);
    const profile = await response.json() as { id?: unknown; bot?: unknown };
    expect(typeof profile.id).toBe("string");
    expect(profile.bot).toBe(true);
  }, 20_000);

  it("enables the authenticated bot only when the explicit server switch is true", async () => {
    expect(isDiscordBotEnabled()).toBe(true);
    const token = process.env.DISCORD_BOT_TOKEN?.trim();
    const response = await fetch("https://discord.com/api/v10/users/@me", { headers: { Authorization: `Bot ${token}` }, signal: AbortSignal.timeout(15_000) });
    expect(response.status).toBe(200);
  }, 20_000);
});
