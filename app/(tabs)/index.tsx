import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import * as Haptics from "expo-haptics";
import * as ImagePicker from "expo-image-picker";
import * as MediaLibrary from "expo-media-library";
import * as Sharing from "expo-sharing";
import { Directory, File, Paths } from "expo-file-system/next";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Image,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";

import { ScreenContainer } from "@/components/screen-container";
import { loadCleanerSettings, saveCleanerQuality } from "@/lib/cleaner-settings";
import { readImageAsDataUrl } from "@/lib/image-upload";
import { trpc } from "@/lib/trpc";
import {
  QUALITY_PRESETS,
  STATUS_LABELS,
  type CleanerImage,
  type QualityPreset,
} from "@/shared/bubble-cleaner-types";

const qualityOptions = Object.entries(QUALITY_PRESETS).map(([id, details]) => ({
  id: id as QualityPreset,
  ...details,
}));

function createImageId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function formatDimensions(width: number, height: number) {
  return `${width.toLocaleString("ar")} × ${height.toLocaleString("ar")}`;
}

async function cacheResult(url: string, imageId: string) {
  const folder = new Directory(Paths.cache, "bubble-cleaner-results");
  folder.create({ idempotent: true, intermediates: true });
  const destination = new File(folder, `bubbleclean-${imageId}.png`);
  const downloaded = await File.downloadFileAsync(url, destination, { idempotent: true });
  return downloaded.uri;
}

export default function HomeScreen() {
  const [images, setImages] = useState<CleanerImage[]>([]);
  const [qualityPreset, setQualityPreset] = useState<QualityPreset>("preserve-detail");
  const [notice, setNotice] = useState("اختر صورًا عالية الجودة للبدء.");
  const [reviewImageId, setReviewImageId] = useState<string | null>(null);
  const [showOriginal, setShowOriginal] = useState(false);
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const cleanMutation = trpc.image.cleanMangaBubbles.useMutation();

  const totalPixels = useMemo(
    () => images.reduce((sum, image) => sum + image.width * image.height, 0),
    [images],
  );
  const reviewImage = useMemo(
    () => images.find((image) => image.id === reviewImageId && image.resultUri),
    [images, reviewImageId],
  );
  const isProcessing = cleanMutation.isPending;

  useEffect(() => {
    loadCleanerSettings()
      .then((settings) => setQualityPreset(settings.defaultQualityPreset))
      .finally(() => setSettingsLoaded(true));
  }, []);

  useEffect(() => {
    if (settingsLoaded) {
      void saveCleanerQuality(qualityPreset);
    }
  }, [qualityPreset, settingsLoaded]);

  const pickImages = useCallback(async () => {
    try {
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
        allowsMultipleSelection: true,
        selectionLimit: 20,
        quality: 1,
        preferredAssetRepresentationMode:
          ImagePicker.UIImagePickerPreferredAssetRepresentationMode.Current,
      });
      if (result.canceled) return;

      const selectedImages: CleanerImage[] = result.assets.map((asset, index) => ({
        id: createImageId(),
        sourceUri: asset.uri,
        fileName: asset.fileName ?? `صفحة ${images.length + index + 1}`,
        mimeType: asset.mimeType ?? "image/jpeg",
        width: asset.width,
        height: asset.height,
        fileSize: asset.fileSize,
        status: "queued",
        progress: 0,
        maskAdjustments: [],
      }));

      setImages((current) => [...current, ...selectedImages]);
      setNotice(`أُضيفت ${selectedImages.length.toLocaleString("ar")} صفحة. حُفظت الأبعاد الأصلية.`);
      if (Platform.OS !== "web") {
        void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      }
    } catch {
      Alert.alert("تعذر اختيار الصور", "أغلق نافذة الاختيار ثم حاول مرة أخرى.");
    }
  }, [images.length]);

  const removeImage = useCallback((id: string) => {
    setImages((current) => current.filter((image) => image.id !== id));
    setNotice("أزيلت الصفحة من الجلسة؛ لم يُحذف الملف الأصلي من جهازك.");
  }, []);

  const processImages = useCallback(async () => {
    if (images.length === 0) {
      void pickImages();
      return;
    }

    const queue = images.filter((image) => image.status !== "completed");
    if (queue.length === 0) {
      setShowOriginal(false);
      setReviewImageId(images[0]?.id ?? null);
      return;
    }

    let completedCount = 0;
    setNotice(`بدأ تنظيف ${queue.length.toLocaleString("ar")} صفحة. لا تُغلق التطبيق أثناء معالجة الصفحة الحالية.`);

    for (const image of queue) {
      setImages((current) =>
        current.map((item) =>
          item.id === image.id ? { ...item, status: "detecting", progress: 12, error: undefined } : item,
        ),
      );

      try {
        const imageDataUrl = await readImageAsDataUrl(image.sourceUri, image.mimeType, image.fileSize);
        setImages((current) =>
          current.map((item) =>
            item.id === image.id ? { ...item, status: "cleaning", progress: 44 } : item,
          ),
        );
        const result = await cleanMutation.mutateAsync({
          imageDataUrl,
          fileName: image.fileName,
          quality: qualityPreset,
          width: image.width,
          height: image.height,
        });
        completedCount += 1;
        setImages((current) =>
          current.map((item) =>
            item.id === image.id
              ? { ...item, status: "completed", progress: 100, resultUri: result.resultUrl, warning: undefined }
              : item,
          ),
        );
        setShowOriginal(false);
        setReviewImageId(image.id);
      } catch (error) {
        const message = error instanceof Error ? error.message : "تعذرت معالجة هذه الصفحة.";
        setImages((current) =>
          current.map((item) =>
            item.id === image.id ? { ...item, status: "failed", progress: 0, error: message } : item,
          ),
        );
      }
    }

    const summary = completedCount === queue.length
      ? `اكتمل تنظيف ${completedCount.toLocaleString("ar")} صفحة. راجع النتيجة قبل التصدير.`
      : `اكتمل تنظيف ${completedCount.toLocaleString("ar")} من ${queue.length.toLocaleString("ar")} صفحة. راجع الصفحات المتعذرة ثم أعد المحاولة.`;
    setNotice(summary);
    if (completedCount > 0 && Platform.OS !== "web") {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    }
  }, [cleanMutation, images, pickImages, qualityPreset]);

  const shareResult = useCallback(async () => {
    if (!reviewImage?.resultUri) return;
    try {
      if (Platform.OS === "web") {
        window.open(reviewImage.resultUri, "_blank", "noopener,noreferrer");
        return;
      }
      const localUri = await cacheResult(reviewImage.resultUri, reviewImage.id);
      if (!(await Sharing.isAvailableAsync())) {
        Alert.alert("المشاركة غير متاحة", "لم يتمكن الجهاز من فتح ورقة المشاركة.");
        return;
      }
      await Sharing.shareAsync(localUri, { mimeType: "image/png", dialogTitle: "مشاركة صفحة مانهوا نظيفة" });
    } catch {
      Alert.alert("تعذرت المشاركة", "حاول حفظ النتيجة في مكتبة الصور أولًا.");
    }
  }, [reviewImage]);

  const saveResult = useCallback(async () => {
    if (!reviewImage?.resultUri) return;
    try {
      if (Platform.OS === "web") {
        window.open(reviewImage.resultUri, "_blank", "noopener,noreferrer");
        return;
      }
      const permission = await MediaLibrary.requestPermissionsAsync(true, ["photo"]);
      if (!permission.granted) {
        Alert.alert("يلزم إذن الحفظ", "اسمح بحفظ الصور لإضافة النتيجة إلى مكتبة جهازك.");
        return;
      }
      const localUri = await cacheResult(reviewImage.resultUri, reviewImage.id);
      await MediaLibrary.saveToLibraryAsync(localUri);
      Alert.alert("تم الحفظ", "أضيفت الصفحة النظيفة إلى مكتبة الصور.");
    } catch {
      Alert.alert("تعذر الحفظ", "تعذر حفظ الصفحة في مكتبة الصور. حاول مرة أخرى.");
    }
  }, [reviewImage]);

  const header = (
    <View>
      <View style={styles.headerRow}>
        <View style={styles.brandLockup}>
          <View style={styles.brandMark}>
            <MaterialIcons name="format-color-fill" size={20} color="#FFFFFF" />
          </View>
          <View>
            <Text style={styles.brandName}>BubbleClean</Text>
            <Text style={styles.brandTagline}>تنظيف فقاعات المانهوا</Text>
          </View>
        </View>
        <View style={styles.betaBadge}>
          <Text style={styles.betaText}>نسخة أولية</Text>
        </View>
      </View>

      <View style={styles.privacyPill}>
        <MaterialIcons name="verified-user" size={16} color="#2563A6" />
        <Text style={styles.privacyText}>الأصل محمي — لا نستبدل أي ملف تلقائيًا</Text>
      </View>

      <View style={styles.heroCard}>
        <View style={styles.bubbleArtwork}>
          <View style={[styles.bubbleShape, styles.bubbleBack]} />
          <View style={[styles.bubbleShape, styles.bubbleFront]}>
            <View style={styles.inkLine} />
            <View style={[styles.inkLine, styles.inkLineShort]} />
            <View style={[styles.inkLine, styles.inkLineMedium]} />
          </View>
          <View style={styles.sparkle}>
            <MaterialIcons name="auto-awesome" size={18} color="#2563A6" />
          </View>
        </View>
        <Text style={styles.heroTitle}>ابدأ بصفحات المانهوا</Text>
        <Text style={styles.heroDescription}>
          اختر الصور الأصلية، ثم نظّف النص داخل فقاعات الحوار دون المساس بالرسم.
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="اختيار صفحات المانهوا"
          onPress={pickImages}
          style={({ pressed }) => [styles.primaryButton, pressed && styles.pressed]}
        >
          <MaterialIcons name="add-photo-alternate" size={21} color="#FFFFFF" />
          <Text style={styles.primaryButtonText}>اختيار الصفحات</Text>
        </Pressable>
      </View>

      <View style={styles.sectionTitleRow}>
        <Text style={styles.sectionTitle}>إعداد جودة التبييض</Text>
        <Text style={styles.sectionCaption}>اختر حسب تعقيد الرسم</Text>
      </View>

      <FlatList
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.qualityList}
        data={qualityOptions}
        keyExtractor={(option) => option.id}
        renderItem={({ item }) => {
          const selected = item.id === qualityPreset;
          return (
            <Pressable
              accessibilityRole="radio"
              accessibilityState={{ selected }}
              onPress={() => setQualityPreset(item.id)}
              style={({ pressed }) => [styles.qualityCard, selected && styles.qualityCardSelected, pressed && styles.pressed]}
            >
              <View style={[styles.radioOuter, selected && styles.radioOuterSelected]}>
                {selected ? <View style={styles.radioInner} /> : null}
              </View>
              <Text style={[styles.qualityTitle, selected && styles.qualityTitleSelected]}>{item.label}</Text>
              <Text style={styles.qualityDescription}>{item.description}</Text>
            </Pressable>
          );
        }}
      />

      {images.length > 0 ? (
        <View style={styles.readySummary}>
          <View>
            <Text style={styles.readyLabel}>الجلسة الحالية</Text>
            <Text style={styles.readyValue}>
              {images.length.toLocaleString("ar")} صفحة · {Math.round(totalPixels / 1_000_000).toLocaleString("ar")} MP
            </Text>
          </View>
          <MaterialIcons name="image-search" size={28} color="#2563A6" />
        </View>
      ) : null}

      <View style={styles.sectionTitleRow}>
        <Text style={styles.sectionTitle}>{images.length > 0 ? "الصفحات المختارة" : "كيف يحافظ على الرسم؟"}</Text>
        {images.length > 0 ? <Text style={styles.sectionCaption}>اختر المزيد عند الحاجة</Text> : null}
      </View>
    </View>
  );

  const emptyState = (
    <View style={styles.infoCard}>
      <View style={styles.infoIcon}>
        <MaterialIcons name="layers-clear" size={22} color="#2563A6" />
      </View>
      <View style={styles.infoContent}>
        <Text style={styles.infoTitle}>تنظيف مقصود لا عشوائي</Text>
        <Text style={styles.infoText}>
          يستهدف المسار النص داخل الفقاعة ثم يرمم الخلفية، ويطلب مراجعة النتيجة بدل أن يغيّر الرسم بصمت.
        </Text>
      </View>
    </View>
  );

  return (
    <ScreenContainer className="flex-1" containerClassName="bg-background">
      <>
        <FlatList
          data={images}
          keyExtractor={(item) => item.id}
          renderItem={({ item, index }) => (
            <View style={styles.imageRow}>
              <Image source={{ uri: item.sourceUri }} style={styles.thumbnail} />
              <View style={styles.imageDetails}>
                <Text style={styles.imageTitle} numberOfLines={1}>{item.fileName}</Text>
                <Text style={styles.imageMeta}>{formatDimensions(item.width, item.height)}</Text>
                <View style={styles.statusRow}>
                  <View style={[styles.statusDot, item.status === "completed" ? styles.completedDot : item.status === "failed" ? styles.failedDot : styles.queuedDot]} />
                  <Text style={[styles.statusText, item.status === "completed" && styles.completedText, item.status === "failed" && styles.failedText]}>{STATUS_LABELS[item.status]}</Text>
                  <Text style={styles.imageIndex}>صفحة {index + 1}</Text>
                </View>
              </View>
              {item.resultUri ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`مراجعة ${item.fileName}`}
                  onPress={() => {
                    setShowOriginal(false);
                    setReviewImageId(item.id);
                  }}
                  style={({ pressed }) => [styles.resultButton, pressed && styles.pressed]}
                >
                  <MaterialIcons name="visibility" size={18} color="#2563A6" />
                </Pressable>
              ) : (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`حذف ${item.fileName}`}
                  onPress={() => removeImage(item.id)}
                  style={({ pressed }) => [styles.removeButton, pressed && styles.pressed]}
                >
                  <MaterialIcons name="close" size={19} color="#51616E" />
                </Pressable>
              )}
            </View>
          )}
          ListHeaderComponent={header}
          ListEmptyComponent={emptyState}
          ListFooterComponent={
            <View style={styles.footerArea}>
              <View style={styles.noticeCard}>
                <MaterialIcons name="info-outline" size={18} color="#51616E" />
                <Text style={styles.noticeText}>{notice}</Text>
              </View>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={images.length > 0 ? "بدء تنظيف الصفحات" : "اختيار صفحات المانهوا"}
                disabled={isProcessing}
                onPress={processImages}
                style={({ pressed }) => [styles.processButton, (images.length === 0 || isProcessing) && styles.processButtonDisabled, pressed && styles.pressed]}
              >
                {isProcessing ? <ActivityIndicator color="#FFFFFF" size="small" /> : <MaterialIcons name={images.length > 0 ? "auto-fix-high" : "photo-library"} size={21} color="#FFFFFF" />}
                <Text style={styles.primaryButtonText}>{isProcessing ? "ينظف الصفحة الحالية…" : images.length > 0 ? "بدء تنظيف الصفحات" : "اختيار الصفحات"}</Text>
              </Pressable>
              <Text style={styles.footerHint}>تظهر كل نتيجة للمراجعة قبل الحفظ أو المشاركة.</Text>
            </View>
          }
          contentContainerStyle={styles.contentContainer}
          showsVerticalScrollIndicator={false}
        />

        <Modal animationType="slide" transparent visible={Boolean(reviewImage)} onRequestClose={() => setReviewImageId(null)}>
          <View style={styles.modalBackdrop}>
            <View style={styles.reviewSheet}>
              <View style={styles.reviewHeader}>
                <Pressable onPress={() => setReviewImageId(null)} style={({ pressed }) => [styles.closeReviewButton, pressed && styles.pressed]}>
                  <MaterialIcons name="close" size={20} color="#51616E" />
                </Pressable>
                <View style={styles.reviewHeading}>
                  <Text style={styles.reviewTitle}>مراجعة النتيجة</Text>
                  <Text style={styles.reviewFileName} numberOfLines={1}>{reviewImage?.fileName}</Text>
                </View>
              </View>

              <View style={styles.previewFrame}>
                {reviewImage ? <Image source={{ uri: showOriginal ? reviewImage.sourceUri : reviewImage.resultUri }} style={styles.reviewImage} resizeMode="contain" /> : null}
                <View style={styles.previewLabel}><Text style={styles.previewLabelText}>{showOriginal ? "الأصل" : "النتيجة النظيفة"}</Text></View>
              </View>

              <Pressable onPress={() => setShowOriginal((value) => !value)} style={({ pressed }) => [styles.compareButton, pressed && styles.pressed]}>
                <MaterialIcons name="compare" size={20} color="#2563A6" />
                <Text style={styles.compareButtonText}>{showOriginal ? "عرض النتيجة النظيفة" : "مقارنة مع الأصل"}</Text>
              </Pressable>

              <View style={styles.reviewNote}>
                <MaterialIcons name="tips-and-updates" size={18} color="#B66A09" />
                <Text style={styles.reviewNoteText}>افحص الفقاعات المتداخلة مع رسم معقد. أعد المعالجة بإعداد «أقصى دقة» إن لزم.</Text>
              </View>

              <View style={styles.exportRow}>
                <Pressable onPress={shareResult} style={({ pressed }) => [styles.secondaryExportButton, pressed && styles.pressed]}>
                  <MaterialIcons name="ios-share" size={19} color="#2563A6" />
                  <Text style={styles.secondaryExportText}>مشاركة</Text>
                </Pressable>
                <Pressable onPress={saveResult} style={({ pressed }) => [styles.saveButton, pressed && styles.pressed]}>
                  <MaterialIcons name="save-alt" size={20} color="#FFFFFF" />
                  <Text style={styles.primaryButtonText}>{Platform.OS === "web" ? "فتح النتيجة" : "حفظ الصورة"}</Text>
                </Pressable>
              </View>
            </View>
          </View>
        </Modal>
      </>
    </ScreenContainer>
  );
}

const styles = StyleSheet.create({
  contentContainer: { paddingHorizontal: 20, paddingTop: 12, paddingBottom: 34, gap: 12 },
  headerRow: { flexDirection: "row-reverse", alignItems: "center", justifyContent: "space-between", marginBottom: 14 },
  brandLockup: { flexDirection: "row-reverse", alignItems: "center", gap: 10 },
  brandMark: { width: 38, height: 38, borderRadius: 13, backgroundColor: "#2563A6", alignItems: "center", justifyContent: "center" },
  brandName: { color: "#16212B", fontSize: 18, fontWeight: "800", letterSpacing: -0.2, textAlign: "right" },
  brandTagline: { color: "#66737D", fontSize: 12, fontWeight: "500", textAlign: "right", marginTop: 1 },
  betaBadge: { backgroundColor: "#E8F1FA", paddingHorizontal: 10, paddingVertical: 6, borderRadius: 99 },
  betaText: { color: "#2563A6", fontSize: 11, fontWeight: "700" },
  privacyPill: { flexDirection: "row-reverse", alignSelf: "flex-start", alignItems: "center", gap: 6, backgroundColor: "#EFF7F3", borderRadius: 99, paddingHorizontal: 11, paddingVertical: 7, marginBottom: 16 },
  privacyText: { color: "#2F675A", fontSize: 11, fontWeight: "600", textAlign: "right" },
  heroCard: { backgroundColor: "#F4F8FC", borderColor: "#D5E5F2", borderWidth: 1, borderRadius: 26, padding: 22, alignItems: "center", marginBottom: 24 },
  bubbleArtwork: { height: 126, width: 176, position: "relative", marginBottom: 12 },
  bubbleShape: { position: "absolute", backgroundColor: "#FFFFFF", borderColor: "#B8C9D7", borderWidth: 2 },
  bubbleBack: { width: 112, height: 74, borderRadius: 36, left: 10, top: 27, opacity: 0.83 },
  bubbleFront: { width: 126, height: 84, borderRadius: 42, right: 8, top: 13, alignItems: "center", justifyContent: "center", gap: 7 },
  inkLine: { width: 56, height: 5, backgroundColor: "#16212B", borderRadius: 3 },
  inkLineShort: { width: 37 },
  inkLineMedium: { width: 46 },
  sparkle: { position: "absolute", left: 76, bottom: 1, width: 36, height: 36, borderRadius: 18, backgroundColor: "#E8F1FA", alignItems: "center", justifyContent: "center" },
  heroTitle: { color: "#16212B", fontSize: 21, fontWeight: "800", textAlign: "center", marginBottom: 7 },
  heroDescription: { color: "#51616E", fontSize: 14, lineHeight: 22, textAlign: "center", marginBottom: 18 },
  primaryButton: { minHeight: 48, flexDirection: "row-reverse", alignItems: "center", justifyContent: "center", gap: 8, backgroundColor: "#2563A6", borderRadius: 15, paddingHorizontal: 22 },
  primaryButtonText: { color: "#FFFFFF", fontSize: 15, fontWeight: "800" },
  sectionTitleRow: { flexDirection: "row-reverse", alignItems: "baseline", justifyContent: "space-between", marginBottom: 10 },
  sectionTitle: { color: "#16212B", fontSize: 16, fontWeight: "800", textAlign: "right" },
  sectionCaption: { color: "#74818B", fontSize: 11, fontWeight: "600", textAlign: "right" },
  qualityList: { paddingBottom: 22, gap: 10, flexDirection: "row-reverse" },
  qualityCard: { width: 156, minHeight: 133, borderRadius: 18, borderWidth: 1, borderColor: "#DDE3E5", padding: 13, backgroundColor: "#FFFFFF" },
  qualityCardSelected: { borderColor: "#2563A6", backgroundColor: "#F4F8FC", shadowColor: "#2563A6", shadowOpacity: 0.08, shadowRadius: 8, elevation: 2 },
  radioOuter: { alignSelf: "flex-end", width: 18, height: 18, borderRadius: 9, borderWidth: 1.5, borderColor: "#A2AFB8", alignItems: "center", justifyContent: "center", marginBottom: 10 },
  radioOuterSelected: { borderColor: "#2563A6" },
  radioInner: { width: 10, height: 10, borderRadius: 5, backgroundColor: "#2563A6" },
  qualityTitle: { color: "#16212B", fontSize: 14, fontWeight: "800", textAlign: "right", marginBottom: 6 },
  qualityTitleSelected: { color: "#1A4E85" },
  qualityDescription: { color: "#66737D", fontSize: 11, lineHeight: 17, textAlign: "right" },
  readySummary: { flexDirection: "row-reverse", alignItems: "center", justifyContent: "space-between", backgroundColor: "#E8F1FA", padding: 15, borderRadius: 17, marginBottom: 24 },
  readyLabel: { color: "#51616E", fontSize: 11, fontWeight: "700", textAlign: "right", marginBottom: 3 },
  readyValue: { color: "#16212B", fontSize: 14, fontWeight: "800", textAlign: "right" },
  infoCard: { flexDirection: "row-reverse", gap: 12, backgroundColor: "#FFFFFF", borderColor: "#E4E7E2", borderWidth: 1, borderRadius: 19, padding: 16 },
  infoIcon: { width: 40, height: 40, borderRadius: 12, backgroundColor: "#E8F1FA", alignItems: "center", justifyContent: "center" },
  infoContent: { flex: 1 },
  infoTitle: { color: "#16212B", fontSize: 14, fontWeight: "800", textAlign: "right", marginBottom: 5 },
  infoText: { color: "#66737D", fontSize: 12, lineHeight: 19, textAlign: "right" },
  imageRow: { flexDirection: "row-reverse", alignItems: "center", backgroundColor: "#FFFFFF", borderColor: "#E4E7E2", borderWidth: 1, borderRadius: 18, padding: 10, gap: 11 },
  thumbnail: { width: 54, height: 54, borderRadius: 11, backgroundColor: "#E8F1FA" },
  imageDetails: { flex: 1, minWidth: 0 },
  imageTitle: { color: "#16212B", fontSize: 13, fontWeight: "800", textAlign: "right" },
  imageMeta: { color: "#74818B", fontSize: 11, fontWeight: "600", textAlign: "right", marginTop: 3 },
  statusRow: { flexDirection: "row-reverse", alignItems: "center", gap: 5, marginTop: 5 },
  statusDot: { width: 7, height: 7, borderRadius: 4 },
  queuedDot: { backgroundColor: "#B66A09" },
  completedDot: { backgroundColor: "#16826A" },
  failedDot: { backgroundColor: "#B42318" },
  statusText: { color: "#B66A09", fontSize: 10, fontWeight: "700" },
  completedText: { color: "#16826A" },
  failedText: { color: "#B42318" },
  imageIndex: { color: "#9AA5AD", fontSize: 10, marginRight: 3 },
  removeButton: { width: 34, height: 34, borderRadius: 12, alignItems: "center", justifyContent: "center", backgroundColor: "#F3F5F4" },
  resultButton: { width: 34, height: 34, borderRadius: 12, alignItems: "center", justifyContent: "center", backgroundColor: "#E8F1FA" },
  footerArea: { paddingTop: 16, gap: 11 },
  noticeCard: { flexDirection: "row-reverse", alignItems: "center", gap: 8, backgroundColor: "#F3F5F4", borderRadius: 13, paddingHorizontal: 12, paddingVertical: 10 },
  noticeText: { color: "#51616E", fontSize: 11, fontWeight: "600", textAlign: "right", flex: 1, lineHeight: 17 },
  processButton: { minHeight: 52, flexDirection: "row-reverse", alignItems: "center", justifyContent: "center", gap: 8, backgroundColor: "#16826A", borderRadius: 16, paddingHorizontal: 22, marginTop: 2 },
  processButtonDisabled: { backgroundColor: "#8296A3" },
  footerHint: { color: "#74818B", fontSize: 11, textAlign: "center", lineHeight: 18 },
  pressed: { opacity: 0.82, transform: [{ scale: 0.98 }] },
  modalBackdrop: { flex: 1, justifyContent: "flex-end", backgroundColor: "rgba(16, 23, 29, 0.42)" },
  reviewSheet: { backgroundColor: "#F9FAF7", borderTopLeftRadius: 28, borderTopRightRadius: 28, paddingHorizontal: 20, paddingTop: 17, paddingBottom: 30, gap: 13 },
  reviewHeader: { flexDirection: "row", alignItems: "center", gap: 11 },
  closeReviewButton: { width: 38, height: 38, borderRadius: 13, alignItems: "center", justifyContent: "center", backgroundColor: "#EEF1EF" },
  reviewHeading: { flex: 1 },
  reviewTitle: { color: "#16212B", fontSize: 17, fontWeight: "800", textAlign: "right" },
  reviewFileName: { color: "#74818B", fontSize: 11, fontWeight: "600", textAlign: "right", marginTop: 2 },
  previewFrame: { height: 286, alignItems: "center", justifyContent: "center", overflow: "hidden", borderRadius: 18, backgroundColor: "#E9ECE9", position: "relative" },
  reviewImage: { width: "100%", height: "100%" },
  previewLabel: { position: "absolute", right: 10, top: 10, borderRadius: 99, backgroundColor: "rgba(22, 33, 43, 0.78)", paddingHorizontal: 10, paddingVertical: 5 },
  previewLabelText: { color: "#FFFFFF", fontSize: 10, fontWeight: "800" },
  compareButton: { flexDirection: "row-reverse", alignItems: "center", justifyContent: "center", gap: 7, minHeight: 44, borderColor: "#C8DCEC", borderWidth: 1, borderRadius: 14, backgroundColor: "#FFFFFF" },
  compareButtonText: { color: "#2563A6", fontSize: 13, fontWeight: "800" },
  reviewNote: { flexDirection: "row-reverse", alignItems: "flex-start", gap: 8, padding: 11, borderRadius: 13, backgroundColor: "#FFF8E9" },
  reviewNoteText: { color: "#7D5318", fontSize: 11, fontWeight: "600", lineHeight: 17, textAlign: "right", flex: 1 },
  exportRow: { flexDirection: "row-reverse", gap: 10 },
  secondaryExportButton: { flex: 1, minHeight: 49, borderWidth: 1, borderColor: "#BFD6E8", borderRadius: 15, backgroundColor: "#FFFFFF", flexDirection: "row-reverse", alignItems: "center", justifyContent: "center", gap: 6 },
  secondaryExportText: { color: "#2563A6", fontSize: 13, fontWeight: "800" },
  saveButton: { flex: 1.35, minHeight: 49, borderRadius: 15, backgroundColor: "#16826A", flexDirection: "row-reverse", alignItems: "center", justifyContent: "center", gap: 7 },
});
