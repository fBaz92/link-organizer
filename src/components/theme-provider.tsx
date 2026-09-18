"use client";

import { ThemeProvider as NextThemesProvider } from "next-themes";

/*
 * Flow: provider del tema (sistema/chiaro/scuro) con strategy "class":
 * next-themes applica .dark sull'html, che Tailwind legge via @custom-variant.
 */
export function ThemeProvider({ children }: { children: React.ReactNode }) {
  return (
    <NextThemesProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
      {children}
    </NextThemesProvider>
  );
}
