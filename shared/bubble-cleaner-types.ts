export type CleanerStatus =
  | "queued"
  | "detecting"
  | "cleaning"
  | "needs-review"
  | "completed"
  | "failed";

export type QualityPreset = "balanced" | "preserve-detail" | "maximum-detail";

export type ExportFormat = "png" | "jpeg";

export interface BubbleMaskAdjustment {
  id: string;
  mode: "include" | "exclude";
  points: Array<{ x: number; y: number }>;
}

export interface CleanerImage {
  id: string;
  sourceUri: string;
  sourceKey?: string;
  fileName: string;
  mimeType: string;
  width: number;
  height: number;
  fileSize?: number;
  status: CleanerStatus;
  progress: number;
  resultUri?: string;
  maskAdjustments: BubbleMaskAdjustment[];
  warning?: string;
  error?: string;
}

export interface CleanerSession {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  images: CleanerImage[];
  qualityPreset: QualityPreset;
  exportFormat: ExportFormat;
  keepOriginalDimensions: boolean;
}

export interface StudioProject {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  images: CleanerImage[];
  qualityPreset: QualityPreset;
  stage: "import" | "cleaning" | "review" | "ready";
}

export interface CleanerSettings {
  defaultQualityPreset: QualityPreset;
  defaultExportFormat: ExportFormat;
  keepOriginalDimensions: boolean;
  saveResultsToGallery: boolean;
}

export const QUALITY_PRESETS: Record<
  QualityPreset,
  { label: string; description: string; processingHint: string }
> = {
  balanced: {
    label: "متوازن",
    description: "توازن بين سرعة المعالجة والحفاظ على تفاصيل الفقاعة.",
    processingHint: "balanced",
  },
  "preserve-detail": {
    label: "حافظ على الرسم",
    description: "يُفضَّل للفقاعات التي تتداخل مع خطوط أو تظليل خفيف.",
    processingHint: "preserve-detail",
  },
  "maximum-detail": {
    label: "أقصى دقة",
    description: "معالجة أبطأ مخصّصة للصفحات ذات الخلفيات المعقدة.",
    processingHint: "maximum-detail",
  },
};

export const STATUS_LABELS: Record<CleanerStatus, string> = {
  queued: "في الانتظار",
  detecting: "يكتشف النص",
  cleaning: "ينظف الفقاعات",
  "needs-review": "تحتاج مراجعة",
  completed: "جاهزة",
  failed: "تعذرت المعالجة",
};
