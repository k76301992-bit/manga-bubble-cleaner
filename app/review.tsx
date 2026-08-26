import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import * as MediaLibrary from "expo-media-library";
import * as Sharing from "expo-sharing";
import { router, useLocalSearchParams } from "expo-router";
import { useRef, useState } from "react";
import { Alert, Image, Platform, Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View } from "react-native";

import { ScreenContainer } from "@/components/screen-container";
import { useBatch } from "@/contexts/batch-context";
import { downloadResultToCache } from "@/lib/result-export";

export default function Review() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { images, retryImage } = useBatch();
  const { width } = useWindowDimensions();
  const readerRef = useRef<ScrollView>(null);
  const [original, setOriginal] = useState(false);
  const [exporting, setExporting] = useState<"share" | "save" | null>(null);
  const item = images.find((image) => image.id === id);
  if (!item || !item.resultUri) return null;

  const imageUri = original ? item.sourceUri : item.resultUri;
  const readerWidth = Math.max(width - 32, 280);
  const readerHeight = Math.round(readerWidth * (item.height / item.width));

  const changeView = () => {
    setOriginal((value) => !value);
    requestAnimationFrame(() => readerRef.current?.scrollTo({ y: 0, animated: false }));
  };

  const getLocalResult = async () => downloadResultToCache(item.resultUri!, item.id);

  const share = async () => {
    try {
      setExporting("share");
      if (Platform.OS === "web") {
        window.open(item.resultUri, "_blank", "noopener,noreferrer");
        return;
      }
      if (!(await Sharing.isAvailableAsync())) throw new Error("المشاركة غير متاحة على هذا الجهاز.");
      const localUri = await getLocalResult();
      await Sharing.shareAsync(localUri, { mimeType: "image/png", UTI: "public.png", dialogTitle: "مشاركة صفحة مانهوا نظيفة" });
    } catch (error) {
      Alert.alert("تعذرت المشاركة", error instanceof Error ? error.message : "تعذر تجهيز الملف للمشاركة. حاول مرة أخرى.");
    } finally {
      setExporting(null);
    }
  };

  const save = async () => {
    try {
      setExporting("save");
      if (Platform.OS === "web") {
        window.open(item.resultUri, "_blank", "noopener,noreferrer");
        return;
      }
      const permission = await MediaLibrary.requestPermissionsAsync(true, ["photo"]);
      if (!permission.granted) {
        Alert.alert("يلزم إذن الحفظ", "اسمح للتطبيق بإضافة النتيجة إلى مكتبة الصور ثم أعد المحاولة.");
        return;
      }
      const localUri = await getLocalResult();
      await MediaLibrary.saveToLibraryAsync(localUri);
      Alert.alert("تم الحفظ", "أضيفت الصفحة النظيفة إلى مكتبة صور جهازك.");
    } catch (error) {
      Alert.alert("تعذر الحفظ", error instanceof Error ? error.message : "تعذر حفظ الصورة في المكتبة.");
    } finally {
      setExporting(null);
    }
  };

  return (
    <ScreenContainer edges={["top", "bottom", "left", "right"]} className="flex-1" containerClassName="bg-background">
      <View style={s.page}>
        <View style={s.top}>
          <Pressable onPress={() => router.back()} style={({ pressed }) => [s.back, pressed && s.pressed]}>
            <MaterialIcons name="arrow-forward" size={20} color="#fff" />
          </Pressable>
          <View style={s.titleArea}>
            <Text style={s.eyebrow}>MANHWA READER / RESULT</Text>
            <Text style={s.title} numberOfLines={1}>{item.fileName}</Text>
          </View>
        </View>

        <View style={s.readerHeader}>
          <View style={s.readerMeta}><MaterialIcons name="unfold-more" size={17} color="#99AABD" /><Text style={s.readerMetaText}>اسحب للقراءة مثل مواقع المانهوا</Text></View>
          <View style={s.modeBadge}><Text style={s.modeText}>{original ? "الأصل" : "النتيجة النظيفة"}</Text></View>
        </View>

        <ScrollView ref={readerRef} style={s.reader} contentContainerStyle={s.readerContent} showsVerticalScrollIndicator>
          <Image source={{ uri: imageUri }} style={{ width: readerWidth, height: readerHeight, backgroundColor: "#FFFFFF" }} resizeMode="stretch" />
        </ScrollView>

        <Pressable onPress={changeView} style={({ pressed }) => [s.compare, pressed && s.pressed]}>
          <MaterialIcons name="compare" size={20} color="#fff" />
          <Text style={s.compareText}>{original ? "العودة إلى النتيجة النظيفة" : "مقارنة الصورة الأصلية"}</Text>
        </Pressable>

        <View style={s.buttons}>
          <Pressable disabled={Boolean(exporting)} onPress={() => retryImage(item.id)} style={({ pressed }) => [s.retry, pressed && s.pressed]}>
            <MaterialIcons name="refresh" size={20} color="#BFD4FF" />
          </Pressable>
          <Pressable disabled={Boolean(exporting)} onPress={share} style={({ pressed }) => [s.secondary, pressed && s.pressed, Boolean(exporting) && s.dim]}>
            <MaterialIcons name="ios-share" size={20} color="#DDE9FF" /><Text style={s.secondaryText}>{exporting === "share" ? "يجهز…" : "مشاركة"}</Text>
          </Pressable>
          <Pressable disabled={Boolean(exporting)} onPress={save} style={({ pressed }) => [s.primary, pressed && s.pressed, Boolean(exporting) && s.dim]}>
            <MaterialIcons name="save-alt" size={20} color="#06101C" /><Text style={s.primaryText}>{exporting === "save" ? "يحفظ…" : "حفظ بالجهاز"}</Text>
          </Pressable>
        </View>
      </View>
    </ScreenContainer>
  );
}

const s = StyleSheet.create({
  page: { flex: 1, paddingHorizontal: 16, gap: 11 }, top: { flexDirection: "row-reverse", alignItems: "center", gap: 12, paddingTop: 4 },
  back: { width: 43, height: 43, borderRadius: 14, backgroundColor: "#18212D", alignItems: "center", justifyContent: "center" }, titleArea: { flex: 1, minWidth: 0 },
  eyebrow: { color: "#7B8898", fontWeight: "800", fontSize: 10, letterSpacing: 1, textAlign: "right" }, title: { color: "#fff", fontWeight: "900", fontSize: 18, textAlign: "right", marginTop: 2 },
  readerHeader: { flexDirection: "row-reverse", justifyContent: "space-between", alignItems: "center", backgroundColor: "#10151E", borderRadius: 14, paddingHorizontal: 12, paddingVertical: 9, borderWidth: 1, borderColor: "#263140" },
  readerMeta: { flexDirection: "row-reverse", alignItems: "center", gap: 5 }, readerMetaText: { color: "#99AABD", fontSize: 10, fontWeight: "700" }, modeBadge: { backgroundColor: "#27354A", borderRadius: 10, paddingHorizontal: 9, paddingVertical: 5 }, modeText: { color: "#DDE9FF", fontSize: 10, fontWeight: "800" },
  reader: { flex: 1, minHeight: 0, borderRadius: 19, borderWidth: 1, borderColor: "#263140", backgroundColor: "#090C11" }, readerContent: { alignItems: "center", paddingVertical: 1 },
  compare: { height: 46, borderColor: "#34455C", borderWidth: 1, borderRadius: 14, alignItems: "center", justifyContent: "center", flexDirection: "row-reverse", gap: 8 }, compareText: { color: "#fff", fontWeight: "800", fontSize: 13 },
  buttons: { flexDirection: "row-reverse", gap: 8, paddingBottom: 5 }, retry: { width: 48, height: 51, borderRadius: 16, backgroundColor: "#172231", alignItems: "center", justifyContent: "center" },
  secondary: { flex: 1, height: 51, borderRadius: 16, backgroundColor: "#172231", alignItems: "center", justifyContent: "center", flexDirection: "row-reverse", gap: 6 }, secondaryText: { color: "#DDE9FF", fontWeight: "800", fontSize: 12 },
  primary: { flex: 1.3, height: 51, borderRadius: 16, backgroundColor: "#F8FAFC", alignItems: "center", justifyContent: "center", flexDirection: "row-reverse", gap: 6 }, primaryText: { color: "#06101C", fontWeight: "900", fontSize: 12 }, pressed: { opacity: 0.78, transform: [{ scale: 0.985 }] }, dim: { opacity: 0.55 },
});
