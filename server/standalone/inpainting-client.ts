const inferenceUrl = () => (process.env.INFERENCE_URL?.trim() || "http://127.0.0.1:8090").replace(/\/$/, "");

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
