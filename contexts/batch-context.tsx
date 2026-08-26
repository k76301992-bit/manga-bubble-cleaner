import AsyncStorage from "@react-native-async-storage/async-storage";
import * as DocumentPicker from "expo-document-picker";
import * as Haptics from "expo-haptics";
import * as ImagePicker from "expo-image-picker";
import { Image, Platform } from "react-native";
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";

import { readImageAsDataUrl } from "@/lib/image-upload";
import { trpc } from "@/lib/trpc";
import { QUALITY_PRESETS, type CleanerImage, type QualityPreset } from "@/shared/bubble-cleaner-types";

type BatchContextValue = {
  images: CleanerImage[];
  history: BatchHistory[];
  quality: QualityPreset;
  notice: string;
  isProcessing: boolean;
  completedCount: number;
  chooseFiles: () => Promise<void>;
  chooseGallery: () => Promise<void>;
  importFromUrl: (url: string) => Promise<void>;
  removeImage: (id: string) => void;
  clearBatch: () => void;
  processBatch: () => Promise<void>;
  retryImage: (id: string) => Promise<void>;
  setQuality: (quality: QualityPreset) => void;
};

export type BatchHistory = { id: string; total: number; completed: number; updatedAt: string };

const BatchContext = createContext<BatchContextValue | null>(null);
const SETTINGS_KEY = "bubbleclean-v2-quality";
const HISTORY_KEY = "bubbleclean-v2-history";

const createId = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

function imageSize(uri: string) {
  return new Promise<{ width: number; height: number }>((resolve) => {
    Image.getSize(uri, (width, height) => resolve({ width, height }), () => resolve({ width: 1200, height: 1600 }));
  });
}

export function BatchProvider({ children }: { children: React.ReactNode }) {
  const [images, setImages] = useState<CleanerImage[]>([]);
  const [batchId, setBatchId] = useState(createId);
  const [history, setHistory] = useState<BatchHistory[]>([]);
  const [quality, setQualityState] = useState<QualityPreset>("preserve-detail");
  const [notice, setNotice] = useState("أنشئ دفعة جديدة لإضافة صفحات المانهوا.");
  const cleanMutation = trpc.image.cleanMangaBubbles.useMutation();
  const importedCleanMutation = trpc.image.cleanImportedMangaBubbles.useMutation();
  const urlMutation = trpc.image.importFromUrl.useMutation();
  const isProcessing = cleanMutation.isPending || importedCleanMutation.isPending;
  const completedCount = images.filter((image) => image.status === "completed").length;

  useEffect(() => {
    AsyncStorage.getItem(SETTINGS_KEY).then((stored) => {
      if (stored === "balanced" || stored === "preserve-detail" || stored === "maximum-detail") setQualityState(stored);
    });
  }, []);

  useEffect(() => {
    AsyncStorage.getItem(HISTORY_KEY).then((raw) => {
      if (!raw) return;
      try { setHistory(JSON.parse(raw)); } catch { /* ignore invalid history */ }
    });
  }, []);

  useEffect(() => {
    if (history.length) void AsyncStorage.setItem(HISTORY_KEY, JSON.stringify(history));
  }, [history]);

  useEffect(() => {
    if (!images.length) return;
    const entry: BatchHistory = { id: batchId, total: images.length, completed: images.filter((image) => image.status === "completed").length, updatedAt: new Date().toISOString() };
    setHistory((current) => [entry, ...current.filter((item) => item.id !== batchId)].slice(0, 4));
  }, [batchId, images]);

  const setQuality = useCallback((next: QualityPreset) => {
    setQualityState(next);
    void AsyncStorage.setItem(SETTINGS_KEY, next);
  }, []);

  const appendLocalAssets = useCallback(async (assets: Array<{ uri: string; name?: string | null; mimeType?: string | null; size?: number; width?: number; height?: number }>) => {
    const prepared = await Promise.all(assets.map(async (asset, index): Promise<CleanerImage> => {
      const dimensions = asset.width && asset.height ? { width: asset.width, height: asset.height } : await imageSize(asset.uri);
      return {
        id: createId(), sourceUri: asset.uri, fileName: asset.name ?? `صفحة ${index + 1}`,
        mimeType: asset.mimeType ?? "image/jpeg", width: dimensions.width, height: dimensions.height,
        fileSize: asset.size, status: "queued", progress: 0, maskAdjustments: [],
      };
    }));
    setImages((current) => [...current, ...prepared]);
    setNotice(`أُضيفت ${prepared.length.toLocaleString("ar")} صفحة إلى الطابور.`);
    if (Platform.OS !== "web") void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  }, []);

  const chooseFiles = useCallback(async () => {
    try {
      const result = await DocumentPicker.getDocumentAsync({ type: "image/*", multiple: true, copyToCacheDirectory: true });
      if (!result.canceled) await appendLocalAssets(result.assets.map((asset) => ({ uri: asset.uri, name: asset.name, mimeType: asset.mimeType, size: asset.size })));
    } catch {
      setNotice("تعذر فتح منتقي الملفات. جرّب اختيار الصور من المعرض أو أدخل رابطًا مباشرًا.");
    }
  }, [appendLocalAssets]);

  const chooseGallery = useCallback(async () => {
    try {
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.Images, allowsMultipleSelection: true, selectionLimit: 20,
        quality: 1, preferredAssetRepresentationMode: ImagePicker.UIImagePickerPreferredAssetRepresentationMode.Current,
      });
      if (!result.canceled) await appendLocalAssets(result.assets.map((asset) => ({ uri: asset.uri, name: asset.fileName, mimeType: asset.mimeType, size: asset.fileSize, width: asset.width, height: asset.height })));
    } catch {
      setNotice("لم يكتمل اختيار المعرض. استخدم زر «من الملفات» كمسار بديل موثوق.");
    }
  }, [appendLocalAssets]);

  const importFromUrl = useCallback(async (url: string) => {
    const normalized = url.trim();
    if (!normalized) throw new Error("أدخل رابطًا مباشرًا لصورة PNG أو JPG أو WebP.");
    const imported = await urlMutation.mutateAsync({ url: normalized });
    setImages((current) => [...current, {
      id: createId(), sourceUri: imported.sourceUrl, sourceKey: imported.sourceKey, fileName: imported.fileName, mimeType: imported.mimeType,
      width: imported.width, height: imported.height, fileSize: imported.fileSize, status: "queued", progress: 0, maskAdjustments: [],
    }]);
    setNotice("أضيفت الصورة من الرابط إلى الطابور.");
  }, [urlMutation]);

  const updateImage = useCallback((id: string, patch: Partial<CleanerImage>) => {
    setImages((current) => current.map((image) => image.id === id ? { ...image, ...patch } : image));
  }, []);

  const processOne = useCallback(async (image: CleanerImage) => {
    updateImage(image.id, { status: "detecting", progress: 12, error: undefined });
    try {
      updateImage(image.id, { status: "cleaning", progress: 48 });
      const result = image.sourceKey
        ? await importedCleanMutation.mutateAsync({ sourceKey: image.sourceKey, fileName: image.fileName, mimeType: image.mimeType as "image/png" | "image/jpeg" | "image/webp", quality, width: image.width, height: image.height })
        : await cleanMutation.mutateAsync({ imageDataUrl: await readImageAsDataUrl(image.sourceUri, image.mimeType, image.fileSize), fileName: image.fileName, quality, width: image.width, height: image.height });
      updateImage(image.id, { status: "completed", progress: 100, resultUri: result.resultUrl });
    } catch (error) {
      updateImage(image.id, { status: "failed", progress: 0, error: error instanceof Error ? error.message : "تعذرت معالجة الصفحة." });
    }
  }, [cleanMutation, importedCleanMutation, quality, updateImage]);

  const processBatch = useCallback(async () => {
    const queue = images.filter((image) => image.status === "queued" || image.status === "failed");
    if (!queue.length) { setNotice("الطابور فارغ أو اكتملت جميع الصفحات."); return; }
    setNotice(`تتم معالجة ${queue.length.toLocaleString("ar")} صفحة بالتتالي. يمكنك مراجعة النتائج عند اكتمالها.`);
    for (const image of queue) await processOne(image);
    if (Platform.OS !== "web") void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
  }, [images, processOne]);

  const value = useMemo<BatchContextValue>(() => ({
    images, history, quality, notice, isProcessing, completedCount,
    chooseFiles, chooseGallery, importFromUrl, removeImage: (id) => setImages((current) => current.filter((image) => image.id !== id)),
    clearBatch: () => { setImages([]); setBatchId(createId()); setNotice("أُفرغت الدفعة الحالية؛ لم يُحذف أي ملف من جهازك."); },
    processBatch, retryImage: async (id) => { const image = images.find((item) => item.id === id); if (image) await processOne(image); }, setQuality,
  }), [chooseFiles, chooseGallery, completedCount, history, images, importFromUrl, isProcessing, notice, processBatch, processOne, quality, setQuality]);

  return <BatchContext.Provider value={value}>{children}</BatchContext.Provider>;
}

export function useBatch() {
  const context = useContext(BatchContext);
  if (!context) throw new Error("useBatch must be used inside BatchProvider");
  return context;
}
