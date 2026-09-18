"use client";

import { useTransition } from "react";
import { Check, Star } from "lucide-react";
import { Button } from "@/components/ui/button";
import { toggleSeenAction, toggleStarredAction } from "@/app/actions";
import { cn } from "@/lib/utils";

/*
 * Flow: flag "visto" e "preferito" della pagina dettaglio. Client leggero:
 * al click parte una server action dentro useTransition (UI reattiva senza
 * stato locale — la verità resta nel DB e le RSC vengono revalidate).
 */
export function FlagToggles({ itemId, seen, starred }: { itemId: number; seen: boolean; starred: boolean }) {
  const [pending, startTransition] = useTransition();

  const toggle = (action: (id: number) => Promise<void>) => {
    startTransition(() => action(itemId));
  };

  return (
    <div className={cn("flex gap-2", pending && "opacity-60")}>
      <Button
        variant={seen ? "default" : "outline"}
        size="sm"
        onClick={() => toggle(toggleSeenAction)}
        className="cursor-pointer"
        aria-pressed={seen}
      >
        <Check className="size-4" />
        {seen ? "Visto" : "Segna come visto"}
      </Button>
      <Button
        variant={starred ? "default" : "outline"}
        size="sm"
        onClick={() => toggle(toggleStarredAction)}
        className="cursor-pointer"
        aria-pressed={starred}
      >
        <Star className={cn("size-4", starred && "fill-current")} />
        {starred ? "Preferito" : "Preferito?"}
      </Button>
    </div>
  );
}
