import fs from "node:fs/promises";

const [requestPath, outputPath] = process.argv.slice(2);
if (!requestPath || !outputPath) throw new Error("Usage: node scripts/retest-full-page.mjs <trpc-request.json> <output.json>");

const request = JSON.parse(await fs.readFile(requestPath, "utf8"));
const input = request["0"].json;
let sourceKey = input.sourceKey;
let resultUrl = "";
let resultKey = sourceKey;
const tileCount = Math.ceil(input.height / 2400);
const summary = [];

for (let tileIndex = 0; tileIndex < tileCount; tileIndex += 1) {
  const payload = { "0": { json: { ...input, sourceKey, tileIndex } } };
  const startedAt = Date.now();
  const response = await fetch("http://127.0.0.1:3000/api/trpc/image.cleanMangaTile?batch=1", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!response.ok) throw new Error(`Tile ${tileIndex + 1} failed: ${response.status} ${await response.text()}`);
  const json = await response.json();
  const result = json[0]?.result?.data?.json;
  if (!result?.resultKey || !result?.resultUrl) throw new Error(`Tile ${tileIndex + 1} returned no result`);
  sourceKey = result.resultKey;
  resultKey = result.resultKey;
  resultUrl = result.resultUrl;
  summary.push({ tileIndex, detectedRegions: result.detectedRegions, processedRegions: result.processedRegions, elapsedMs: Date.now() - startedAt });
}

await fs.writeFile(outputPath, JSON.stringify({ resultKey, resultUrl, summary }, null, 2));
console.log(JSON.stringify({ resultKey, resultUrl, summary }, null, 2));
