import { File } from "expo-file-system/next";
import { Platform } from "react-native";

const MAX_SOURCE_BYTES = 20 * 1024 * 1024;

export async function readImageAsDataUrl(uri: string, mimeType: string, knownSize?: number) {
  if (knownSize && knownSize > MAX_SOURCE_BYTES) {
    throw new Error("الصورة أكبر من 20 ميغابايت. صدّرها دون ضغط مفرط ثم حاول مجددًا.");
  }

  if (Platform.OS === "web") {
    const response = await fetch(uri);
    const blob = await response.blob();
    if (blob.size > MAX_SOURCE_BYTES) {
      throw new Error("الصورة أكبر من 20 ميغابايت. اختر نسخة أصغر قليلًا.");
    }
    const base64 = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error("تعذر قراءة الصورة المختارة."));
      reader.onload = () => resolve(String(reader.result));
      reader.readAsDataURL(blob);
    });
    return base64;
  }

  const file = new File(uri);
  if (file.size > MAX_SOURCE_BYTES) {
    throw new Error("الصورة أكبر من 20 ميغابايت. اختر نسخة أصغر قليلًا.");
  }
  const base64 = await file.base64();
  return `data:${mimeType};base64,${base64}`;
}
