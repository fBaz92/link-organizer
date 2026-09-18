"use client";

import { useEffect, useState } from "react";
import { useTheme } from "next-themes";
import { Monitor, Moon, Sun } from "lucide-react";
import { Button } from "@/components/ui/button";

/*
 * Flow: toggle del tema a tre stati (sistema → chiaro → scuro). Monta solo
 * l'icona dopo l'hydration per evitare mismatch SSR.
 */
export function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);

  useEffect(() => setMounted(true), []);

  if (!mounted) return <Button variant="ghost" size="icon" aria-label="Tema" />;

  const Icon = theme === "dark" ? Moon : theme === "light" ? Sun : Monitor;
  const next = theme === "system" ? "light" : theme === "light" ? "dark" : "system";
  const label = theme === "system" ? "Tema di sistema" : theme === "light" ? "Tema chiaro" : "Tema scuro";

  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={() => setTheme(next)}
      title={`Tema: ${label} (clic per ${next === "system" ? "sistema" : next === "light" ? "chiaro" : "scuro"})`}
    >
      <Icon className="size-4" />
    </Button>
  );
}
