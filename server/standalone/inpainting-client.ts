import sharp from "sharp";

const inferenceUrl = () => (process.env.INFERENCE_URL?.trim() || "http://127.0.0.1:8090").replace(/\/$/, "");

export type LocalComicTextRegion = { x: number; y: number; width: number; height: number; confidence: number };
export type LocalComicTextDetection = { regions: LocalComicTextRegion[]; textMask?: Buffer };

// Production (Railway, 2026-09-01..09-04) showed the trained inpainting path
// failing on 100% of regions: the old 20s default timeout aborted healthy
// crops, concurrent Discord jobs piled simultaneous requests onto the
// single-threaded sidecar until the process died, and after that every
// request failed with "fetch failed" for days. Three guards fix this:
//   1. a realistic default timeout (120s, env-overridable as before),
//   2. retries with backoff to survive a sidecar restart gap,
//   3. a small global queue so parallel jobs cannot stampede the sidecar.
const INFERENCE_TIMEOUT_MS = Math.max(5_000, Number(process.env.INFERENCE_TIMEOUT_MS || 120_000));
const INFERENCE_RETRIES = Math.max(1, Number(process.env.INFERENCE_RETRIES || 2));
const INFERENCE_MAX_CONCURRENCY = Math.max(1, Number(process.env.INFERENCE_MAX_CONCURRENCY || 2));

let activeInpaintRequests = 0;
const inpaintQueue: Array<() => void> = [];

async function acquireInpaintSlot(): Promise<() => void> {
  if (activeInpaintRequests < INFERENCE_MAX_CONCURRENCY) {
    activeInpaintRequests += 1;
    return releaseInpaintSlot;
  }
  return await new Promise((resolve) => inpaintQueue.push(() => { activeInpaintRequests += 1; resolve(releaseInpaintSlot); }));
}

function releaseInpaintSlot(): void {
  const next = inpaintQueue.shift();
  if (next) next();
  else activeInpaintRequests = Math.max(0, activeInpaintRequests - 1);
}

export async function requestTrainedInpainting(image: Buffer, mask: Buffer) {
  if (process.env.INFERENCE_ENABLED?.trim().toLowerCase() === "false") { console.warn("[inference] trained inpainting disabled by INFERENCE_ENABLED=false"); return undefined; }
  const maskActive = mask.some((v) => v > 0);
  if (!maskActive) { console.warn("[inference] trained inpainting skipped: empty mask"); return undefined; }
  const activeMaskBytes = mask.filter((v) => v > 0).length;
  console.info(`[inference] requesting inpaint: image=${image.length}B mask=${mask.length}B activeMask=${activeMaskBytes}`);
  const body = JSON.stringify({ image: image.toString("base64"), mask: mask.toString("base64") });
  let lastError: unknown;
  for (let attempt = 0; attempt < INFERENCE_RETRIES; attempt += 1) {
    const release = await acquireInpaintSlot();
    try {
      const response = await fetch(`${inferenceUrl()}/v1/inpaint`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: AbortSignal.timeout(INFERENCE_TIMEOUT_MS),
        body,
      });
      if (!response.ok) {
        const detail = await response.text();
        console.warn(`[inference] inpaint failed: HTTP ${response.status} ${detail.slice(0, 200)}`);
        throw new Error(`inference service returned ${response.status}`);
      }
      const result = Buffer.from(await response.arrayBuffer());
      console.info(`[inference] inpaint OK: result=${result.length}B attempt=${attempt + 1} elapsedMs=${response.headers.get("x-inference-time-ms")}`);
      return { image: result, elapsedMs: Number(response.headers.get("x-inference-time-ms") || 0) };
    } catch (error) {
      lastError = error;
      console.warn("[inference] trained inpainting FAILED:", error instanceof Error ? error.message : error);
    } finally {
      release();
    }
    if (attempt + 1 < INFERENCE_RETRIES) await new Promise((resolve) => setTimeout(resolve, 1_500 * (attempt + 1)));
  }
  void lastError;
  return undefined;
}

async function requestComicTextDetection(image: Buffer, includeTextMask: boolean): Promise<LocalComicTextDetection | undefined> {
  if (process.env.INFERENCE_ENABLED?.trim().toLowerCase() === "false" || process.env.TEXT_DETECTOR_ENABLED?.trim().toLowerCase() === "false") return undefined;
  try {
    const requestBody = JSON.stringify({ image: image.toString("base64"), includeTextMask });
    let response: Response | undefined;
    let lastError: unknown;
    const detectorAttempts = Math.max(1, Number(process.env.TEXT_DETECTOR_RETRIES || 1));
    for (let attempt = 0; attempt < detectorAttempts; attempt += 1) {
      try {
        response = await fetch(`${inferenceUrl()}/v1/detect-text`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          // ONNX scans several 2048px windows per tile on Railway CPU. A 12s
          // timeout aborts a healthy request and the retry then piles another
          // inference onto the sidecar lock. Keep one long request by default.
          signal: AbortSignal.timeout(Number(process.env.TEXT_DETECTOR_TIMEOUT_MS || 180_000)),
          body: requestBody,
        });
        if (response.ok) break;
        lastError = new Error(`text detector returned ${response.status}`);
      } catch (error) {
        lastError = error;
      }
      if (attempt + 1 < detectorAttempts) await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
    }
    if (!response?.ok) throw lastError instanceof Error ? lastError : new Error("text detector request failed");
    const payload = await response.json() as { regions?: unknown; textMask?: unknown };
    if (!Array.isArray(payload.regions)) throw new Error("text detector response has no regions");
    const regions = payload.regions.flatMap((region) => {
      if (!region || typeof region !== "object") return [];
      const value = region as Record<string, unknown>;
      const valid = [value.x, value.y, value.width, value.height, value.confidence].every((item) => typeof item === "number" && Number.isFinite(item));
      return valid && (value.width as number) >= 8 && (value.height as number) >= 8 ? [{ x: Math.round(value.x as number), y: Math.round(value.y as number), width: Math.round(value.width as number), height: Math.round(value.height as number), confidence: value.confidence as number }] : [];
    });
    const encodedTextMask = includeTextMask && typeof payload.textMask === "string" && /^[A-Za-z0-9+/]+={0,2}$/.test(payload.textMask) ? Buffer.from(payload.textMask, "base64") : undefined;
    const textMask = encodedTextMask ? await sharp(encodedTextMask).greyscale().raw().toBuffer() : undefined;
    return { regions, textMask };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.warn("[inference] local comic text detection failed", detail);
    if (process.env.TEXT_DETECTOR_STRICT?.trim().toLowerCase() === "true") {
      throw new Error(`كاشف النص المحلي غير متاح: ${detail}`);
    }
    return undefined;
  }
}

export async function requestLocalComicTextDetection(image: Buffer): Promise<LocalComicTextRegion[] | undefined> {
  return (await requestComicTextDetection(image, false))?.regions;
}

export async function requestLocalComicTextDetectionWithMask(image: Buffer): Promise<LocalComicTextDetection | undefined> {
  return requestComicTextDetection(image, true);
}
