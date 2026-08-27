import Constants from "expo-constants";
import { Directory, File, Paths } from "expo-file-system";
import { Platform } from "react-native";
import type { BubbleMaskAdjustment, QualityPreset } from "@/shared/bubble-cleaner-types";

const acceptedTypes = new Set(["image/png", "image/jpeg", "image/webp"]);
const maxBytes = 20 * 1024 * 1024;

function cleanFileName(value: string) { return value.replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 96) || "manhwa-page"; }

async function readLocalImageBytes(uri: string) {
  if (Platform.OS === "web") {
    const response = await fetch(uri);
    if (!response.ok) throw new Error("لا يمكن الوصول إلى الصورة المختارة في المتصفح. أعد اختيارها.");
    return new Uint8Array(await response.arrayBuffer());
  }
  const source = new File(uri);
  if (!source.exists) throw new Error("لا يمكن الوصول إلى ملف الصورة المحلي. أعد اختياره من جهازك.");
  return source.bytes();
}

export function getStandaloneApiBaseUrl() {
  const configured = process.env.EXPO_PUBLIC_API_BASE_URL?.replace(/\/$/, "");
  if (configured) return configured;
  const hostUri = Constants.expoConfig?.hostUri;
  if (hostUri?.startsWith("8081-")) return `https://${hostUri.replace(/^8081-/, "3000-")}`;
  if (Platform.OS === "web" && typeof window !== "undefined") return `${window.location.protocol}//${window.location.host.replace(/^8081-/, "3000-")}`;
  throw new Error("حدد EXPO_PUBLIC_API_BASE_URL بعنوان خادم المعالجة قبل بناء IPA.");
}

export async function downloadImageToDevice(url: string) {
  const parsed = new URL(url.trim());
  if (!/^https?:$/.test(parsed.protocol)) throw new Error("يجب أن يكون الرابط HTTP أو HTTPS مباشرًا لصورة.");
  const response = await fetch(parsed.toString());
  const mimeType = (response.headers.get("content-type") ?? "").split(";")[0].toLowerCase();
  if (!response.ok || !acceptedTypes.has(mimeType)) throw new Error("تعذر تنزيل صورة PNG أو JPG أو WebP من الرابط.");
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (!bytes.length || bytes.byteLength > maxBytes) throw new Error("يجب ألا تتجاوز الصورة 20 ميغابايت.");
  if (Platform.OS === "web") return { uri: URL.createObjectURL(new Blob([bytes], { type: mimeType })), mimeType, fileSize: bytes.byteLength, fileName: cleanFileName(decodeURIComponent(parsed.pathname.split("/").pop() || "linked-manhwa-page.png")) };
  const directory = new Directory(Paths.document, "bubbleclean-originals"); directory.create({ idempotent: true, intermediates: true });
  const target = new File(directory, `${Date.now()}-${cleanFileName(decodeURIComponent(parsed.pathname.split("/").pop() || "linked-manhwa-page.png"))}`); target.create({ overwrite: true, intermediates: true }); target.write(bytes);
  return { uri: target.uri, mimeType, fileSize: bytes.byteLength, fileName: target.name };
}

export async function processImageOnStandaloneServer(input: { sourceUri: string; fileName: string; mimeType: string; quality: QualityPreset; maskAdjustments: BubbleMaskAdjustment[] }) {
  const baseUrl = getStandaloneApiBaseUrl();
  const bytes = await readLocalImageBytes(input.sourceUri);
  if (!bytes.length || bytes.byteLength > maxBytes) throw new Error("يجب ألا تتجاوز الصورة 20 ميغابايت.");
  const response = await fetch(`${baseUrl}/api/v1/clean`, { method: "POST", headers: { "Content-Type": input.mimeType, "X-File-Name": cleanFileName(input.fileName), "X-Cleaning-Quality": input.quality, "X-Mask-Adjustments": encodeURIComponent(JSON.stringify(input.maskAdjustments)) }, body: bytes });
  if (!response.ok) {
    const body = await response.text();
    try { const parsed = JSON.parse(body) as { error?: string; message?: string }; throw new Error(parsed.message || parsed.error || "تعذرت معالجة الصفحة."); } catch (error) { if (error instanceof SyntaxError) throw new Error(body.slice(0, 240) || "تعذرت معالجة الصفحة."); throw error; }
  }
  const resultBytes = new Uint8Array(await response.arrayBuffer());
  if (Platform.OS === "web") return { resultUri: URL.createObjectURL(new Blob([resultBytes], { type: "image/png" })), jobId: response.headers.get("x-cleaner-job-id") ?? undefined };
  const directory = new Directory(Paths.document, "bubbleclean-results"); directory.create({ idempotent: true, intermediates: true });
  const target = new File(directory, `${Date.now()}-${cleanFileName(input.fileName).replace(/\.[^.]+$/, "")}-clean.png`); target.create({ overwrite: true, intermediates: true }); target.write(resultBytes);
  return { resultUri: target.uri, jobId: response.headers.get("x-cleaner-job-id") ?? undefined };
}
