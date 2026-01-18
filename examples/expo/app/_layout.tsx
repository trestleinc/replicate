import "react-native-get-random-values";
import "react-native-random-uuid";

import { useEffect } from "react";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { ThemeProvider } from "@react-navigation/native";
import { useColorScheme } from "react-native";
import * as SplashScreen from "expo-splash-screen";
import { IntervalsProvider } from "@/contexts/IntervalsContext";
import { FilterProvider } from "@/contexts/FilterContext";
import { NAV_THEME } from "@/lib/theme";
import "../global.css";

SplashScreen.preventAutoHideAsync();

export default function RootLayout() {
	const colorScheme = useColorScheme();
	const theme = colorScheme === "dark" ? NAV_THEME.dark : NAV_THEME.light;

	useEffect(() => {
		SplashScreen.hideAsync();
	}, []);

	return (
		<ThemeProvider value={theme}>
			<FilterProvider>
				<IntervalsProvider>
					<Stack
						screenOptions={{
							headerStyle: {
								backgroundColor: theme.colors.card,
							},
							headerTintColor: theme.colors.text,
							headerTitleStyle: {
								fontWeight: "600",
							},
							contentStyle: {
								backgroundColor: theme.colors.background,
							},
						}}
					>
						<Stack.Screen
							name="index"
							options={{
								title: "Intervals",
							}}
						/>
						<Stack.Screen
							name="interval/[id]"
							options={{
								title: "Interval",
							}}
						/>
					</Stack>
				</IntervalsProvider>
			</FilterProvider>
			<StatusBar style={colorScheme === "dark" ? "light" : "dark"} />
		</ThemeProvider>
	);
}
