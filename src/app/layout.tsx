import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { ThemeProvider } from "@/components/theme-provider";
import { Toaster } from "@/components/ui/sonner";
import "./globals.css";

/*
 * Flow: layout radice dell'app. Carica i due font Geist (body + mono) come
 * variabili CSS usate da Tailwind (--font-geist → --font-sans) e dal preset
 * typeset (--typeset-font-*). Il ThemeProvider (next-themes) governa
 * chiaro/scuro/sistema; Toaster mostra i feedback delle server actions.
 */

const geist = Geist({
  subsets: ["latin"],
  variable: "--font-geist",
});

const geistMono = Geist_Mono({
  subsets: ["latin"],
  variable: "--font-geist-mono",
});

export const metadata: Metadata = {
  title: "Stash",
  description: "Il tuo archivio personale di link, video, articoli e documenti.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="it"
      className={`${geist.variable} ${geistMono.variable} h-full antialiased font-sans`}
      suppressHydrationWarning
    >
      <body className="min-h-full flex flex-col">
        <ThemeProvider>
          {children}
          <Toaster position="bottom-right" />
        </ThemeProvider>
      </body>
    </html>
  );
}
