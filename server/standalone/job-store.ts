import { MongoClient, type Collection } from "mongodb";

export type ProcessingJobStatus = "queued" | "detecting" | "cleaning" | "completed" | "failed" | "requires-reupload";

export type ProcessingJob = {
  id: string;
  fileName: string;
  mimeType: string;
  width?: number;
  height?: number;
  tileCount?: number;
  completedTiles: number;
  status: ProcessingJobStatus;
  error?: string;
  sourceStored: false;
  resultStored: false;
  createdAt: string;
  updatedAt: string;
  expiresAt: Date;
};

const inMemoryJobs = new Map<string, ProcessingJob>();
let mongoClientPromise: Promise<MongoClient> | null = null;
let mongoCollectionPromise: Promise<Collection<ProcessingJob>> | null = null;

async function getCollection(): Promise<Collection<ProcessingJob> | null> {
  const uri = process.env.MONGODB_URI;
  if (!uri) return null;
  if (!mongoCollectionPromise) {
    mongoClientPromise = MongoClient.connect(uri, { connectTimeoutMS: 3000, serverSelectionTimeoutMS: 3000, maxPoolSize: 3 });
    mongoCollectionPromise = mongoClientPromise.then(async (client) => {
      const collection = client.db(process.env.MONGODB_DB_NAME || "manga_bubble_cleaner").collection<ProcessingJob>("processing_jobs");
      await collection.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
      return collection;
    }).catch((error) => {
      mongoClientPromise = null;
      mongoCollectionPromise = null;
      throw error;
    });
  }
  return mongoCollectionPromise;
}

async function persistInBackground(job: ProcessingJob) {
  try {
    const collection = await getCollection();
    if (collection) await collection.updateOne({ id: job.id }, { $set: job }, { upsert: true });
  } catch (error) {
    // MongoDB keeps descriptive state only; it must never hold image bytes or delay cleanup.
    console.warn("[jobs] MongoDB metadata write failed", error instanceof Error ? error.message : error);
  }
}

function persist(job: ProcessingJob) {
  void persistInBackground(job);
}

export async function createProcessingJob(input: Pick<ProcessingJob, "id" | "fileName" | "mimeType">) {
  const now = new Date();
  const job: ProcessingJob = {
    ...input,
    status: "queued",
    completedTiles: 0,
    sourceStored: false,
    resultStored: false,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000),
  };
  inMemoryJobs.set(job.id, job);
  persist(job);
  return job;
}

export async function updateProcessingJob(id: string, patch: Partial<Omit<ProcessingJob, "id" | "createdAt" | "sourceStored" | "resultStored">>) {
  const existing = inMemoryJobs.get(id);
  if (!existing) return;
  const next: ProcessingJob = { ...existing, ...patch, updatedAt: new Date().toISOString(), sourceStored: false, resultStored: false };
  inMemoryJobs.set(id, next);
  persist(next);
}

export async function getProcessingJob(id: string) {
  const local = inMemoryJobs.get(id);
  if (local) return local;
  try {
    const collection = await getCollection();
    const saved = collection ? await collection.findOne({ id }) : null;
    if (!saved) return null;
    // A stored record never means that its image or result can be resumed after a process restart.
    return { ...saved, status: "requires-reupload" as const, error: "انتهت نسخة الصورة المؤقتة بعد إعادة تشغيل الخادم؛ أعد رفع الصفحة للمتابعة." };
  } catch {
    return null;
  }
}
