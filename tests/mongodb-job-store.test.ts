import { afterAll, describe, expect, it } from "vitest";
import { MongoClient } from "mongodb";
import { createProcessingJob, getProcessingJob, updateProcessingJob } from "../server/standalone/job-store";

const uri = process.env.MONGODB_URI;
const testId = `mongo-health-${Date.now()}`;

describe.skipIf(!uri)("MongoDB metadata-only job store", () => {
  it("stores status metadata without source or result bytes", async () => {
    await createProcessingJob({ id: testId, fileName: "page.webp", mimeType: "image/webp" });
    await updateProcessingJob(testId, { status: "cleaning", completedTiles: 2, tileCount: 8 });
    const job = await getProcessingJob(testId);
    expect(job).toMatchObject({ id: testId, status: "cleaning", completedTiles: 2, tileCount: 8, sourceStored: false, resultStored: false });
    expect(JSON.stringify(job)).not.toContain("base64");
  }, 35_000);
});

afterAll(async () => {
  if (!uri) return;
  const client = await MongoClient.connect(uri);
  await client.db(process.env.MONGODB_DB_NAME || "manga_bubble_cleaner").collection("processing_jobs").deleteOne({ id: testId });
  await client.close();
});
