import "@/global.css";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import "react-native-reanimated";
import "@/lib/_core/nativewind-pressable";
import { ThemeProvider } from "@/lib/theme-provider";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { BatchProvider } from "@/contexts/batch-context";

export const unstable_settings = {
  anchor: "(tabs)",
};

export default function RootLayout() {
  return (
    <ThemeProvider>
      <SafeAreaProvider>
        <GestureHandlerRootView style={{ flex: 1 }}>
          <BatchProvider>
          {/* Default to hiding native headers so raw route segments don't appear (e.g. "(tabs)", "products/[id]"). */}
          {/* If a screen needs the native header, explicitly enable it and set a human title via Stack.Screen options. */}
          {/* in order for ios apps tab switching to work properly, use presentation: "fullScreenModal" for login page, whenever you decide to use presentation: "modal*/}
          <Stack screenOptions={{ headerShown: false }}>
            <Stack.Screen name="(tabs)" />
            <Stack.Screen name="oauth/callback" />
          </Stack>
          <StatusBar style="light" />
          </BatchProvider>
        </GestureHandlerRootView>
      </SafeAreaProvider>
    </ThemeProvider>
  );
}
