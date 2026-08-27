import express, { type NextFunction, type Request, type Response } from "express";
import sharp, { type Metadata } from "sharp";
import { randomUUID } from "crypto";
import { cleanImageInMemory, type CleaningQuality, type ManualMaskAdjustment } from "./cleaner";
import { createProcessingJob, getProcessingJob, updateProcessingJob } from "./job-store";

const supportedTypes = new Set(["image/png", "image/jpeg", "image/webp"]);
const qualities = new Set<CleaningQuality>(["balanced", "preserve-detail", "maximum-detail"]);
const cleanName = (value: string) => value.replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 96) || "manhwa-page";
let cleaningInProgress = false;

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
  app.post("/api/v1/clean", express.raw({ type: [...supportedTypes], limit: "20mb" }), async (req, res) => {
    if (!hasValidServiceKey(req.headers.authorization)) return res.status(401).json({ error: "مفتاح خدمة غير صالح." });
    const mimeType = (req.headers["content-type"] ?? "").split(";")[0].toLowerCase();
    const fileName = cleanName(typeof req.headers["x-file-name"] === "string" ? req.headers["x-file-name"] : "manhwa-page");
    const requestedQuality = typeof req.headers["x-cleaning-quality"] === "string" ? req.headers["x-cleaning-quality"] as CleaningQuality : "preserve-detail";
    const quality = qualities.has(requestedQuality) ? requestedQuality : "preserve-detail";
    if (!supportedTypes.has(mimeType) || !Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: "أرسل ملف PNG أو JPG أو WebP في جسم الطلب." });
    if (cleaningInProgress) return res.status(429).json({ error: "server-busy", message: "الخادم يعالج صفحة أخرى الآن؛ أعد المحاولة بعد انتهائها." });
    let metadata: Metadata;
    try { metadata = await sharp(req.body, { animated: false }).metadata(); }
    catch { return res.status(422).json({ error: "تعذر قراءة ملف الصورة." }); }
    if (!metadata.width || !metadata.height || metadata.width * metadata.height > 20_000_000) return res.status(413).json({ error: "أبعاد الصورة تتجاوز الحد الذاكري الآمن للخادم (20 مليون بكسل)." });
    cleaningInProgress = true;
    const id = randomUUID(); await createProcessingJob({ id, fileName, mimeType }); res.setHeader("X-Cleaner-Job-Id", id);
    try {
      const result = await cleanImageInMemory({ image: req.body, mimeType, quality, maskAdjustments: parseAdjustments(typeof req.headers["x-mask-adjustments"] === "string" ? req.headers["x-mask-adjustments"] : undefined), onTile: async ({ tileIndex, tileCount, status }) => { await updateProcessingJob(id, { status, completedTiles: status === "cleaning" ? tileIndex : tileIndex, tileCount }); } });
      await updateProcessingJob(id, { status: "completed", completedTiles: result.tileCount, tileCount: result.tileCount, width: result.width, height: result.height });
      res.setHeader("Cache-Control", "no-store"); res.type("image/png"); res.attachment(`${fileName.replace(/\.[^.]+$/, "")}-clean.png`); return res.send(result.image);
    } catch (error) {
      const message = error instanceof Error ? error.message : "تعذرت معالجة الصورة.";
      console.error(`[standalone-api] job ${id} failed: ${message}`);
      await updateProcessingJob(id, { status: "failed", error: message });
      return res.status(422).json({ jobId: id, error: message });
    } finally {
      cleaningInProgress = false;
    }
  });
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (typeof error === "object" && error && "type" in error && (error as { type?: string }).type === "entity.too.large") return res.status(413).json({ error: "الصورة تتجاوز حد 20 ميغابايت." });
    console.error(error); return res.status(500).json({ error: "خطأ غير متوقع في خادم المعالجة." });
  });
  const port = Number(process.env.PORT || 3000); app.listen(port, "0.0.0.0", () => console.log(`[standalone-api] listening on ${port}`));
}

startServer().catch((error) => { console.error(error); process.exitCode = 1; });
