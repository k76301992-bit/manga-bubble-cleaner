import express, { type NextFunction, type Request, type Response } from "express";
import sharp from "sharp";
import { type CleaningQuality, type ManualMaskAdjustment } from "./cleaner";
import { startDiscordBot } from "./discord-bot";
import { ProcessingRequestError, processImageInMemory, supportedImageTypes } from "./processing-service";
import { getProcessingJob } from "./job-store";

const qualities = new Set<CleaningQuality>(["balanced", "preserve-detail", "maximum-detail"]);

function hasValidServiceKey(authorization: string | undefined) {
  const requiredKey = process.env.SERVICE_API_KEY?.trim();
  if (!requiredKey) return true;
  return authorization === `Bearer ${requiredKey}`;
}

function parseAdjustments(value: string | undefined): ManualMaskAdjustment[] | undefined {
  if (!value) return undefined;
  try {
    const decoded = JSON.parse(decodeURIComponent(value));
    if (!Array.isArray(decoded) || decoded.length > 32) return undefined;
    return decoded.filter((item): item is ManualMaskAdjustment => item && item.mode === "include" && Array.isArray(item.points) && item.points.length >= 2 && item.points.length <= 128 && item.points.every((point: unknown) => typeof point === "object" && point !== null && typeof (point as { x?: unknown }).x === "number" && typeof (point as { y?: unknown }).y === "number"));
  } catch { return undefined; }
}

async function startServer() {
  // A single Sharp worker and disabled cache keep the memory-only job model predictable on small servers.
  sharp.cache(false); sharp.concurrency(1);
  const app = express(); app.disable("x-powered-by");
  app.use((req, res, next) => {
    const requestOrigin = req.headers.origin;
    const allowedOrigin = process.env.ALLOWED_ORIGIN?.trim();
    if (requestOrigin && allowedOrigin && requestOrigin === allowedOrigin) res.header("Access-Control-Allow-Origin", allowedOrigin);
    else if (requestOrigin && process.env.NODE_ENV !== "production") res.header("Access-Control-Allow-Origin", requestOrigin);
    else if (requestOrigin && process.env.NODE_ENV === "production") return res.status(403).json({ error: "مصدر الويب غير مصرح به." });
    res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.header("Access-Control-Allow-Headers", "Content-Type, X-File-Name, X-Cleaning-Quality, X-Mask-Adjustments, Authorization");
    if (req.method === "OPTIONS") return res.sendStatus(204);
    next();
  });
  app.get("/api/health", (_req, res) => res.json({ ok: true, service: "manga-bubble-cleaner-standalone", imagesPersisted: false }));
  app.get("/api/v1/jobs/:id", async (req, res) => {
    if (!hasValidServiceKey(req.headers.authorization)) return res.status(401).json({ error: "مفتاح خدمة غير صالح." });
    const job = await getProcessingJob(req.params.id);
    if (!job) return res.status(404).json({ error: "Job غير موجود." });
    return res.json(job);
  });
  app.post("/api/v1/clean", express.raw({ type: [...supportedImageTypes], limit: "50mb" }), async (req, res) => {
    if (!hasValidServiceKey(req.headers.authorization)) return res.status(401).json({ error: "مفتاح خدمة غير صالح." });
    const mimeType = (req.headers["content-type"] ?? "").split(";")[0].toLowerCase();
    const fileName = typeof req.headers["x-file-name"] === "string" ? req.headers["x-file-name"] : "manhwa-page";
    const requestedQuality = typeof req.headers["x-cleaning-quality"] === "string" ? req.headers["x-cleaning-quality"] as CleaningQuality : "preserve-detail";
    const quality = qualities.has(requestedQuality) ? requestedQuality : "preserve-detail";
    try {
      const result = await processImageInMemory({ image: req.body, mimeType, fileName, quality, maskAdjustments: parseAdjustments(typeof req.headers["x-mask-adjustments"] === "string" ? req.headers["x-mask-adjustments"] : undefined) });
      res.setHeader("X-Cleaner-Job-Id", result.jobId); res.setHeader("Cache-Control", "no-store"); res.type("image/png"); res.attachment(`${result.fileName.replace(/\.[^.]+$/, "")}-clean.png`); return res.send(result.image);
    } catch (error) {
      if (error instanceof ProcessingRequestError) return res.status(error.statusCode).json({ jobId: error.jobId, error: error.code, message: error.message });
      console.error("[standalone-api] unexpected processing error", error); return res.status(500).json({ error: "خطأ غير متوقع في خادم المعالجة." });
    }
  });
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (typeof error === "object" && error && "type" in error && (error as { type?: string }).type === "entity.too.large") return res.status(413).json({ error: "الصورة تتجاوز حد 50 ميغابايت." });
    console.error(error); return res.status(500).json({ error: "خطأ غير متوقع في خادم المعالجة." });
  });
  const port = Number(process.env.PORT || 3000); app.listen(port, "0.0.0.0", () => { console.log(`[standalone-api] listening on ${port}`); startDiscordBot(); });
}

startServer().catch((error) => { console.error(error); process.exitCode = 1; });
