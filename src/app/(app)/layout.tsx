import Link from "next/link";
import { Archive, Search } from "lucide-react";
import { requireAuth, authEnabled } from "@/lib/auth";
import { logoutAction } from "@/app/actions";
import { AddDialog } from "@/components/add-dialog";
import { BottomNav, SidebarNav } from "@/components/app-nav";
import { KeepAlive } from "@/components/keepalive";
import { ThemeToggle } from "@/components/theme-toggle";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/*
 * Flow: shell dell'app (route group protetto). requireAuth() ferma chi non
 * ha sessione; la shell è un server component: l'unico JS è la navigazione
 * attiva (usePathname), il dialog di aggiunta e il toggle tema. La ricerca
 * è un form GET: funziona anche senza hydration.
 * Tutto il gruppo è dinamico: legge sessione e DB per richiesta.
 */
export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  await requireAuth();

  return (
    <div className="min-h-dvh">
      <KeepAlive />
      <aside className="fixed inset-y-0 left-0 z-20 hidden w-60 flex-col border-r bg-card px-4 py-5 md:flex">
        <Link href="/" className="mb-6 flex items-center gap-2 px-2 text-lg font-extrabold tracking-tight">
          <Archive className="size-5 text-primary" />
          Stash
        </Link>
        <SidebarNav />
        <div className="mt-auto space-y-2 px-2">
          {authEnabled() && (
            <form action={logoutAction}>
              <Button variant="ghost" size="sm" className="w-full justify-start text-muted-foreground cursor-pointer">
                Esci
              </Button>
            </form>
          )}
          <p className="text-[11px] leading-snug text-muted-foreground">
            Dump dei link da Telegram, li leggi qui.
          </p>
        </div>
      </aside>

      <div className="md:pl-60">
        <header className="sticky top-0 z-10 border-b bg-background/80 backdrop-blur supports-[backdrop-filter]:bg-background/70">
          <div className="mx-auto flex max-w-5xl items-center gap-2 px-4 py-3 sm:gap-3">
            <Link href="/" className="text-base font-extrabold md:hidden">
              Stash
            </Link>
            <form action="/" role="search" className="flex flex-1 items-center gap-1">
              <Input
                name="q"
                type="search"
                placeholder="Cerca nell'archivio…"
                aria-label="Cerca nell'archivio"
                className="h-9"
              />
              <Button type="submit" variant="ghost" size="icon" aria-label="Avvia ricerca" className="cursor-pointer">
                <Search className="size-4" />
              </Button>
            </form>
            <AddDialog />
            <ThemeToggle />
          </div>
        </header>

        <main className="mx-auto max-w-5xl px-4 py-6 pb-24 md:pb-12">{children}</main>
      </div>

      <BottomNav />
    </div>
  );
}
