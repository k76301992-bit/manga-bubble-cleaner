import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import { Tabs } from "expo-router";
import { Platform } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { HapticTab } from "@/components/haptic-tab";

export default function TabsLayout() {
  const insets = useSafeAreaInsets();
  const bottom = Platform.OS === "web" ? 12 : Math.max(insets.bottom, 10);
  return (
    <Tabs screenOptions={{
      headerShown: false,
      tabBarButton: HapticTab,
      tabBarActiveTintColor: "#F8FAFC",
      tabBarInactiveTintColor: "#738094",
      tabBarStyle: { height: 60 + bottom, paddingTop: 7, paddingBottom: bottom, backgroundColor: "#0C1119", borderTopColor: "#202937" },
    }}>
      <Tabs.Screen name="index" options={{ title: "الاستوديو", tabBarIcon: ({ color }) => <MaterialIcons name="dashboard" size={23} color={color} /> }} />
      <Tabs.Screen name="projects" options={{ title: "المشاريع", tabBarIcon: ({ color }) => <MaterialIcons name="folder-copy" size={23} color={color} /> }} />
      <Tabs.Screen name="queue" options={{ title: "الطابور", tabBarIcon: ({ color }) => <MaterialIcons name="view-list" size={23} color={color} /> }} />
      <Tabs.Screen name="team" options={{ title: "الفريق", tabBarIcon: ({ color }) => <MaterialIcons name="groups" size={23} color={color} /> }} />
      <Tabs.Screen name="settings" options={{ title: "الإعدادات", tabBarIcon: ({ color }) => <MaterialIcons name="tune" size={23} color={color} /> }} />
    </Tabs>
  );
}
