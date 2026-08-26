import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import { Alert, FlatList, Pressable, StyleSheet, Text, View } from "react-native";

import { ScreenContainer } from "@/components/screen-container";
import { useBatch } from "@/contexts/batch-context";
import type { StudioProject } from "@/shared/bubble-cleaner-types";

export default function ProjectsScreen() {
  const { project, projects, startNewProject } = useBatch();
  return <ScreenContainer className="flex-1" containerClassName="bg-background"><FlatList
    data={projects}
    keyExtractor={(item) => item.id}
    contentContainerStyle={s.page}
    ListHeaderComponent={<>
      <View style={s.top}><View><Text style={s.eyebrow}>PROJECT LIBRARY</Text><Text style={s.title}>مشاريع المانهوا</Text></View><Pressable onPress={() => Alert.alert("مشروع جديد", "سيحفظ المشروع الحالي ويبدأ مساحة عمل فارغة.", [{ text: "إلغاء", style: "cancel" }, { text: "بدء مشروع", onPress: () => startNewProject() }])} style={s.add}><MaterialIcons name="add" size={24} color="#071019" /></Pressable></View>
      <View style={s.banner}><View style={s.bannerIcon}><MaterialIcons name="cloud-done" size={21} color="#F8FAFC" /></View><View style={{ flex: 1 }}><Text style={s.bannerTitle}>عملك محفوظ محليًا</Text><Text style={s.bannerText}>تظل الدفعات والنتائج والمشروع النشط موجودة عند العودة للتطبيق.</Text></View></View>
      <Text style={s.section}>المشروع النشط</Text>
      <ProjectCard project={project} active />
      <Text style={s.section}>مكتبة الاستوديو</Text>
    </>}
    renderItem={({ item }) => item.id === project.id ? null : <ProjectCard project={item} />}
    ListEmptyComponent={<Text style={s.empty}>سيظهر كل مشروع تبدأه هنا تلقائيًا.</Text>}
  /></ScreenContainer>;
}

function ProjectCard({ project, active }: { project: StudioProject; active?: boolean }) {
  const completed = project.images.filter((image) => image.status === "completed").length;
  const stage = { import: "استيراد", cleaning: "قيد المعالجة", review: "بالمراجعة", ready: "جاهز" }[project.stage];
  return <View style={[s.card, active && s.activeCard]}><View style={s.cover}><MaterialIcons name="auto-fix-high" size={25} color="#F8FAFC" /></View><View style={s.cardBody}><View style={s.cardTop}><Text style={s.projectName} numberOfLines={1}>{project.name}</Text><View style={[s.stage, active && s.activeStage]}><Text style={s.stageText}>{active ? "نشط" : stage}</Text></View></View><Text style={s.meta}>{project.images.length.toLocaleString("ar")} صفحة · {completed.toLocaleString("ar")} نتيجة مكتملة</Text><View style={s.progressTrack}><View style={[s.progress, { width: `${project.images.length ? Math.round((completed / project.images.length) * 100) : 0}%` }]} /></View><Text style={s.updated}>آخر حفظ: {new Date(project.updatedAt).toLocaleDateString("ar")}</Text></View></View>;
}
const s = StyleSheet.create({ page: { padding: 20, paddingBottom: 40, gap: 12 }, top: { flexDirection: "row-reverse", justifyContent: "space-between", alignItems: "center", marginBottom: 3 }, eyebrow: { color: "#8795A8", fontSize: 10, fontWeight: "900", letterSpacing: 1 }, title: { color: "#F8FAFC", fontSize: 28, fontWeight: "900", textAlign: "right", marginTop: 4 }, add: { width: 46, height: 46, borderRadius: 16, alignItems: "center", justifyContent: "center", backgroundColor: "#F8FAFC" }, banner: { flexDirection: "row-reverse", gap: 11, backgroundColor: "#152036", borderColor: "#294363", borderWidth: 1, borderRadius: 19, padding: 14, marginVertical: 8 }, bannerIcon: { width: 38, height: 38, borderRadius: 13, alignItems: "center", justifyContent: "center", backgroundColor: "#2A5FBA" }, bannerTitle: { color: "#F8FAFC", fontSize: 13, fontWeight: "900", textAlign: "right" }, bannerText: { color: "#A7B7CB", fontSize: 11, lineHeight: 17, textAlign: "right", marginTop: 3 }, section: { color: "#F8FAFC", fontSize: 16, fontWeight: "900", textAlign: "right", marginTop: 10, marginBottom: 1 }, card: { flexDirection: "row-reverse", gap: 12, backgroundColor: "#10151E", borderColor: "#202937", borderWidth: 1, borderRadius: 21, padding: 12 }, activeCard: { borderColor: "#497FC5", backgroundColor: "#131E2D" }, cover: { width: 54, height: 66, borderRadius: 16, alignItems: "center", justifyContent: "center", backgroundColor: "#263E63" }, cardBody: { flex: 1, minWidth: 0 }, cardTop: { flexDirection: "row-reverse", justifyContent: "space-between", gap: 7 }, projectName: { flex: 1, color: "#FFFFFF", fontSize: 14, fontWeight: "900", textAlign: "right" }, stage: { backgroundColor: "#222D3C", borderRadius: 10, paddingHorizontal: 8, paddingVertical: 4 }, activeStage: { backgroundColor: "#E8F2FF" }, stageText: { color: "#B7C4D4", fontSize: 9, fontWeight: "800" }, meta: { color: "#9CAABA", fontSize: 10, textAlign: "right", marginTop: 5 }, progressTrack: { height: 5, backgroundColor: "#283344", borderRadius: 5, overflow: "hidden", marginTop: 10 }, progress: { height: "100%", backgroundColor: "#62AAFF", borderRadius: 5 }, updated: { color: "#788799", fontSize: 9, textAlign: "right", marginTop: 7 }, empty: { color: "#8B99A9", textAlign: "center", fontSize: 12, marginVertical: 18 } });
