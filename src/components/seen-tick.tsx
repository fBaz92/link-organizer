"use client";

import { useTransition } from "react";
import { Eye } from "lucide-react";
import { toggleSeenAction } from "@/app/actions";
import { cn } from "@/lib/utils";

/*
 * Flow: occhio "visto" direttamente sulla card dell'archivio. Sta sopra lo
 * stretch-link (z-10) così il click marca l'item senza aprire il dettaglio;
 * la server action aggiorna il DB e revalida lista + dettaglio. Il chip scuro
 * semi-trasparente garantisce contrasto su qualsiasi thumbnail e nei due temi;
 * l'occhio è grigio finché da vedere, bianco quando visto. Un-tick possibile
 * (torna "da vedere"), stesso comportamento della pagina dettaglio.
 */
export function SeenTick({
  itemId,
  seen,
  className,
}: {
  itemId: number;
  seen: boolean;
  className?: string;
}) {
  const [pending, startTransition] = useTransition();

  const label = seen ? "Segna come da vedere" : "Segna come visto";

  return (
    <button
      type="button"
      onClick={() => startTransition(() => toggleSeenAction(itemId))}
      disabled={pending}
      aria-pressed={seen}
      title={label}
      className={cn(
        "flex size-7 cursor-pointer items-center justify-center rounded-full border border-white/15 bg-black/55 backdrop-blur-sm transition-colors",
        seen ? "text-white" : "text-zinc-400 hover:text-white",
        pending && "opacity-60",
        className,
      )}
    >
      <Eye className="size-4" aria-hidden />
      <span className="sr-only">{label}</span>
    </button>
  );
}
