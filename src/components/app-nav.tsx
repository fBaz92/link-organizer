"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Archive, CircleHelp, Dices, Download, Tags } from "lucide-react";
import { cn } from "@/lib/utils";

/*
 * Flow: navigazione dell'app in due varianti dallo stesso set di voci:
 * sidebar verticale su ≥md (client per evidenziare la voce attiva via
 * usePathname) e bottom-nav su mobile, thumb-friendly (target 44px+).
 */
const NAV_ITEMS = [
  { href: "/", label: "Archivio", icon: Archive },
  { href: "/scarica", label: "Scarica video", icon: Download },
  { href: "/lucky", label: "Fortuna", icon: Dices },
  { href: "/tags", label: "Tag", icon: Tags },
  { href: "/aiuto", label: "Aiuto", icon: CircleHelp },
] as const;

function isActive(pathname: string, href: string): boolean {
  return href === "/" ? pathname === "/" : pathname.startsWith(href);
}

export function SidebarNav() {
  const pathname = usePathname();

  return (
    <nav className="flex flex-col gap-1" aria-label="Principale">
      {NAV_ITEMS.map((item) => (
        <Link
          key={item.href}
          href={item.href}
          className={cn(
            "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors cursor-pointer",
            isActive(pathname, item.href)
              ? "bg-primary/10 text-primary"
              : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
          )}
        >
          <item.icon className="size-4" />
          {item.label}
        </Link>
      ))}
    </nav>
  );
}

export function BottomNav() {
  const pathname = usePathname();

  return (
    <nav
      className="fixed inset-x-0 bottom-0 z-20 flex border-t bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80 md:hidden"
      aria-label="Principale"
    >
      {NAV_ITEMS.map((item) => (
        <Link
          key={item.href}
          href={item.href}
          className={cn(
            "flex flex-1 flex-col items-center gap-1 py-2.5 text-[11px] font-medium transition-colors",
            isActive(pathname, item.href) ? "text-primary" : "text-muted-foreground",
          )}
        >
          <item.icon className="size-5" />
          <span className="max-w-full truncate px-1">{item.label}</span>
        </Link>
      ))}
    </nav>
  );
}
