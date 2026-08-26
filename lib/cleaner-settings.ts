import AsyncStorage from "@react-native-async-storage/async-storage";

import type { CleanerSettings, QualityPreset } from "@/shared/bubble-cleaner-types";

const SETTINGS_KEY = "manga-bubble-cleaner:settings";

export const DEFAULT_CLEANER_SETTINGS: CleanerSettings = {
  defaultQualityPreset: "preserve-detail",
  defaultExportFormat: "png",
  keepOriginalDimensions: true,
  saveResultsToGallery: false,
};

function isQualityPreset(value: unknown): value is QualityPreset {
  return value === "balanced" || value === "preserve-detail" || value === "maximum-detail";
}

export function normalizeCleanerSettings(value: unknown): CleanerSettings {
  if (!value || typeof value !== "object") return DEFAULT_CLEANER_SETTINGS;
  const candidate = value as Partial<CleanerSettings>;
  return {
    defaultQualityPreset: isQualityPreset(candidate.defaultQualityPreset)
      ? candidate.defaultQualityPreset
      : DEFAULT_CLEANER_SETTINGS.defaultQualityPreset,
    defaultExportFormat: candidate.defaultExportFormat === "jpeg" ? "jpeg" : "png",
    keepOriginalDimensions: candidate.keepOriginalDimensions !== false,
    saveResultsToGallery: candidate.saveResultsToGallery === true,
  };
}

export async function loadCleanerSettings() {
  const raw = await AsyncStorage.getItem(SETTINGS_KEY);
  if (!raw) return DEFAULT_CLEANER_SETTINGS;
  try {
    return normalizeCleanerSettings(JSON.parse(raw));
  } catch {
    return DEFAULT_CLEANER_SETTINGS;
  }
}

export async function saveCleanerQuality(defaultQualityPreset: QualityPreset) {
  const current = await loadCleanerSettings();
  await AsyncStorage.setItem(
    SETTINGS_KEY,
    JSON.stringify({ ...current, defaultQualityPreset }),
  );
}
