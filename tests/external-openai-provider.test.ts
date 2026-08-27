import { describe, expect, it } from "vitest";

describe("external OpenAI-compatible provider", () => {
  it("accepts the configured bearer key for the models endpoint", async () => {
    const apiKey = process.env.EXTERNAL_OPENAI_API_KEY;
    expect(apiKey).toBeTruthy();
    const response = await fetch("https://ggg-production-739f.up.railway.app/v1/models", {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
      signal: AbortSignal.timeout(20_000),
    });
    expect(response.status).toBe(200);
    const body = await response.json() as { data?: Array<{ id?: string }> };
    expect(body.data?.some((model) => model.id === "qwen-vision")).toBe(true);
  }, 30_000);
});
