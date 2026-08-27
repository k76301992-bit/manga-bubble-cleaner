const inferenceUrl = () => (process.env.INFERENCE_URL?.trim() || "http://127.0.0.1:8090").replace(/\/$/, "");

export type LocalComicTextRegion = { x: number; y: number; width: number; height: number; confidence: number };

export async function requestTrainedInpainting(image: Buffer, mask: Buffer) {
  if (process.env.INFERENCE_ENABLED?.trim().toLowerCase() === "false") return undefined;
  try {
    const response = await fetch(`${inferenceUrl()}/v1/inpaint`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(Number(process.env.INFERENCE_TIMEOUT_MS || 20_000)),
      body: JSON.stringify({ image: image.toString("base64"), mask: mask.toString("base64") }),
    });
    if (!response.ok) throw new Error(`inference service returned ${response.status}`);
    return { image: Buffer.from(await response.arrayBuffer()), elapsedMs: Number(response.headers.get("x-inference-time-ms") || 0) };
  } catch (error) {
    console.warn("[inference] trained inpainting skipped", error instanceof Error ? error.message : error);
    return undefined;
  }
}

export async function requestLocalComicTextDetection(image: Buffer): Promise<LocalComicTextRegion[] | undefined> {
  if (process.env.INFERENCE_ENABLED?.trim().toLowerCase() === "false" || process.env.TEXT_DETECTOR_ENABLED?.trim().toLowerCase() === "false") return undefined;
  try {
    const response = await fetch(`${inferenceUrl()}/v1/detect-text`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(Number(process.env.TEXT_DETECTOR_TIMEOUT_MS || 12_000)),
      body: JSON.stringify({ image: image.toString("base64") }),
    });
    if (!response.ok) throw new Error(`text detector returned ${response.status}`);
    const payload = await response.json() as { regions?: unknown };
    if (!Array.isArray(payload.regions)) throw new Error("text detector response has no regions");
    return payload.regions.flatMap((region) => {
      if (!region || typeof region !== "object") return [];
      const value = region as Record<string, unknown>;
      const valid = [value.x, value.y, value.width, value.height, value.confidence].every((item) => typeof item === "number" && Number.isFinite(item));
      return valid && (value.width as number) >= 8 && (value.height as number) >= 8 ? [{ x: Math.round(value.x as number), y: Math.round(value.y as number), width: Math.round(value.width as number), height: Math.round(value.height as number), confidence: value.confidence as number }] : [];
    });
  } catch (error) {
    console.warn("[inference] local comic text detection skipped", error instanceof Error ? error.message : error);
    return undefined;
  }
}
