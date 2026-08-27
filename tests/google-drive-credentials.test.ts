import { describe, expect, it } from "vitest";
import { validateGoogleServiceAccountCredentials, validateGoogleUserDriveCredentials } from "../server/standalone/google-drive";

describe("Google Drive service-account credentials", () => {
  it("obtains a Google access token when Drive credentials are configured", async () => {
    if (!process.env.GOOGLE_SERVICE_ACCOUNT_JSON?.trim()) return;
    await expect(validateGoogleServiceAccountCredentials()).resolves.toBe(true);
  }, 20_000);
});

describe("Google Drive user OAuth credentials", () => {
  it("uses the supplied refresh token to access the connected user's Drive", async () => {
    if (!process.env.GDRIVE_CLIENT_ID?.trim() || !process.env.GDRIVE_CLIENT_SECRET?.trim() || !process.env.GDRIVE_REFRESH_TOKEN?.trim()) return;
    await expect(validateGoogleUserDriveCredentials()).resolves.toBe(true);
  }, 20_000);
});
