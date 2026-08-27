import { Readable } from "node:stream";
import { google, type drive_v3 } from "googleapis";
import type { JWTInput } from "google-auth-library";
import { extname, parse } from "node:path";
import { type BatchImage, extractImagesFromZip, mimeTypeForFileName, naturalNameCompare } from "./batch-processing";

const FOLDER_MIME_TYPE = "application/vnd.google-apps.folder";
const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive";

type DriveResource = { type: "folder" | "file"; id: string };

function safeFolderName(value: string) {
  return `${parse(value).name.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "manhwa-results"}-cleaned`;
}

function configuredDrive() {
  const rawCredentials = process.env.GOOGLE_SERVICE_ACCOUNT_JSON?.trim();
  if (!rawCredentials) throw new Error("لم يُضبط حساب خدمة Google Drive على الخادم.");
  let credentials: JWTInput;
  try { credentials = JSON.parse(rawCredentials) as JWTInput; }
  catch { throw new Error("صيغة GOOGLE_SERVICE_ACCOUNT_JSON غير صالحة."); }
  const auth = new google.auth.GoogleAuth({ credentials, scopes: [DRIVE_SCOPE] });
  return google.drive({ version: "v3", auth });
}

export async function validateGoogleServiceAccountCredentials() {
  const rawCredentials = process.env.GOOGLE_SERVICE_ACCOUNT_JSON?.trim();
  if (!rawCredentials) return false;
  let credentials: JWTInput;
  try { credentials = JSON.parse(rawCredentials) as JWTInput; }
  catch { throw new Error("صيغة GOOGLE_SERVICE_ACCOUNT_JSON غير صالحة."); }
  const auth = new google.auth.GoogleAuth({ credentials, scopes: [DRIVE_SCOPE] });
  const client = await auth.getClient();
  const token = await client.getAccessToken();
  if (!token.token) return false;
  const drive = google.drive({ version: "v3", auth });
  await drive.files.list({ pageSize: 1, fields: "nextPageToken", supportsAllDrives: true, includeItemsFromAllDrives: true });
  return true;
}

export function parseGoogleDriveUrl(value: string): DriveResource | undefined {
  let url: URL;
  try { url = new URL(value); } catch { return undefined; }
  if (url.protocol !== "https:" || !["drive.google.com", "www.drive.google.com", "docs.google.com"].includes(url.hostname.toLowerCase())) return undefined;
  const folder = /\/folders\/([a-zA-Z0-9_-]+)/.exec(url.pathname)?.[1];
  const file = /\/file\/d\/([a-zA-Z0-9_-]+)/.exec(url.pathname)?.[1] ?? url.searchParams.get("id") ?? undefined;
  return folder ? { type: "folder", id: folder } : file && /^[a-zA-Z0-9_-]+$/.test(file) ? { type: "file", id: file } : undefined;
}

async function driveFileBytes(drive: drive_v3.Drive, fileId: string) {
  const response = await drive.files.get({ fileId, alt: "media", supportsAllDrives: true }, { responseType: "arraybuffer" });
  return Buffer.from(response.data as ArrayBuffer);
}

export async function readGoogleDriveSource(link: string): Promise<{ sourceName: string; images: BatchImage[] }> {
  const resource = parseGoogleDriveUrl(link);
  if (!resource) throw new Error("رابط Google Drive غير صالح.");
  const drive = configuredDrive();
  if (resource.type === "folder") {
    const [folder, listing] = await Promise.all([
      drive.files.get({ fileId: resource.id, fields: "id,name,mimeType", supportsAllDrives: true }),
      drive.files.list({ q: `'${resource.id}' in parents and trashed = false`, fields: "files(id,name,mimeType,size)", orderBy: "name", pageSize: 100, supportsAllDrives: true, includeItemsFromAllDrives: true }),
    ]);
    const files = (listing.data.files ?? []).filter((file) => file.id && file.name && file.mimeType && mimeTypeForFileName(file.name));
    const images: BatchImage[] = [];
    for (const file of files.sort((a, b) => naturalNameCompare(a.name!, b.name!))) {
      images.push({ name: file.name!, mimeType: mimeTypeForFileName(file.name!)!, image: await driveFileBytes(drive, file.id!) });
    }
    return { sourceName: folder.data.name ?? "drive-folder", images };
  }
  const metadata = await drive.files.get({ fileId: resource.id, fields: "id,name,mimeType,size", supportsAllDrives: true });
  if (!metadata.data.name || !metadata.data.id) throw new Error("تعذر قراءة ملف Google Drive.");
  const data = await driveFileBytes(drive, metadata.data.id);
  if (extname(metadata.data.name).toLowerCase() === ".zip") return { sourceName: parse(metadata.data.name).name, images: await extractImagesFromZip(data) };
  const mimeType = mimeTypeForFileName(metadata.data.name);
  if (!mimeType) throw new Error("يقبل رابط Drive صورة PNG أو JPG أو WebP أو ملف ZIP فقط.");
  return { sourceName: parse(metadata.data.name).name, images: [{ name: metadata.data.name, mimeType, image: data }] };
}

export async function createGoogleDriveResultFolder(input: { sourceName: string; results: Array<{ outputName: string; image: Buffer }> }) {
  const drive = configuredDrive();
  const folder = await drive.files.create({ requestBody: { name: safeFolderName(input.sourceName), mimeType: FOLDER_MIME_TYPE }, fields: "id,webViewLink", supportsAllDrives: true });
  const folderId = folder.data.id;
  if (!folderId) throw new Error("تعذر إنشاء مجلد نتائج Google Drive.");
  await drive.permissions.create({ fileId: folderId, requestBody: { type: "anyone", role: "reader", allowFileDiscovery: false }, supportsAllDrives: true, sendNotificationEmail: false });
  for (const result of input.results) {
    await drive.files.create({ requestBody: { name: result.outputName, parents: [folderId], mimeType: "image/png" }, media: { mimeType: "image/png", body: Readable.from(result.image) }, fields: "id", supportsAllDrives: true });
  }
  return { id: folderId, url: folder.data.webViewLink ?? `https://drive.google.com/drive/folders/${folderId}` };
}
