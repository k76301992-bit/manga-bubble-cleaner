import { describe, expect, it } from "vitest";
import { validateGoogleServiceAccountCredentials } from "../server/standalone/google-drive";

describe("Google Drive service-account credentials", () => {
  it("obtains a Google access token when Drive credentials are configured", async () => {
    if (!process.env.GOOGLE_SERVICE_ACCOUNT_JSON?.trim()) return;
    await expect(validateGoogleServiceAccountCredentials()).resolves.toBe(true);
  }, 20_000);
});
