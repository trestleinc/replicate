import type { Theme } from "@react-navigation/native";

export const NAV_THEME: { light: Theme; dark: Theme } = {
  light: {
    dark: false,
    colors: {
      background: "hsl(45, 30%, 96%)",
      border: "hsl(45, 10%, 88%)",
      card: "hsl(45, 12%, 94%)",
      notification: "hsl(0, 65%, 45%)",
      primary: "hsl(25, 65%, 45%)",
      text: "hsl(30, 15%, 15%)",
    },
    fonts: {
      regular: { fontFamily: "System", fontWeight: "400" },
      medium: { fontFamily: "System", fontWeight: "500" },
      bold: { fontFamily: "System", fontWeight: "700" },
      heavy: { fontFamily: "System", fontWeight: "900" },
    },
  },
  dark: {
    dark: true,
    colors: {
      background: "hsl(30, 15%, 10%)",
      border: "hsl(0, 0%, 12%)",
      card: "hsl(30, 12%, 14%)",
      notification: "hsl(0, 65%, 55%)",
      primary: "hsl(30, 70%, 55%)",
      text: "hsl(45, 30%, 96%)",
    },
    fonts: {
      regular: { fontFamily: "System", fontWeight: "400" },
      medium: { fontFamily: "System", fontWeight: "500" },
      bold: { fontFamily: "System", fontWeight: "700" },
      heavy: { fontFamily: "System", fontWeight: "900" },
    },
  },
};
