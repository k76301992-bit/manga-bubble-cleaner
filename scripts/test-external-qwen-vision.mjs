import fs from "node:fs/promises";

const [imagePath, outputPath] = process.argv.slice(2);
if (!imagePath || !outputPath) throw new Error("Usage: node scripts/test-external-qwen-vision.mjs <image-path> <output-json>");

const baseUrl = (process.env.EXTERNAL_OPENAI_BASE_URL ?? "https://ggg-production-739f.up.railway.app/v1").replace(/\/$/, "");
const apiKey = process.env.EXTERNAL_OPENAI_API_KEY;
const model = process.env.EXTERNAL_OPENAI_MODEL ?? "qwen";
const timeoutMs = Number(process.env.EXTERNAL_OPENAI_TIMEOUT_MS ?? 180_000);
const image = await fs.readFile(imagePath);
const prompt = process.env.EXTERNAL_VISION_PROMPT ?? "Inspect this 900x1100 manhwa crop. Return ONLY valid JSON: {\"regions\":[{\"kind\":\"dialogue\"|\"caption\",\"bbox_2d\":[ymin,xmin,ymax,xmax],\"text\":\"optional\"}]}. Include only readable dialogue or narration inside a closed speech bubble or caption box. Ignore sound effects, logos, and all writing outside closed bubbles. Coordinates must be pixels in the supplied 900x1100 image. Include the full letter layers: fill, outline, glow, and shadow.";
const payload = {
  model,
  temperature: 0,
  max_tokens: 500,
  messages: [{
    role: "user",
    content: [
      {
        type: "text",
        text: prompt,
      },
      { type: "image_url", image_url: { url: `data:image/png;base64,${image.toString("base64")}` } },
    ],
  }],
};

const headers = { "Content-Type": "application/json", Accept: "application/json" };
if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
const response = await fetch(`${baseUrl}/chat/completions`, { method: "POST", headers, body: JSON.stringify(payload), signal: AbortSignal.timeout(timeoutMs) });
const body = await response.text();
let parsedBody;
try { parsedBody = JSON.parse(body); } catch { parsedBody = { raw: body.slice(0, 5_000) }; }
await fs.writeFile(outputPath, JSON.stringify({ model, status: response.status, ok: response.ok, response: parsedBody }, null, 2));
console.log(JSON.stringify({ model, status: response.status, ok: response.ok, response: parsedBody }, null, 2));
if (!response.ok) process.exitCode = 1;
