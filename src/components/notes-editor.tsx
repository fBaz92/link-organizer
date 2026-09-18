"use client";

import { useActionState } from "react";
import { NotebookPen } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { saveNotesAction, type ActionResult } from "@/app/actions";

/*
 * Flow: editor delle note personali in markdown. Le note vengono renderizzate
 * (MarkdownView, wrapper typeset) nel riquadro affianco; qui si modificano.
 * Save → server action → revalidate della pagina → preview aggiornata.
 */
export function NotesEditor({ itemId, notes }: { itemId: number; notes?: string }) {
  const [state, formAction, pending] = useActionState<ActionResult | null, FormData>(saveNotesAction, null);

  return (
    <form action={formAction} className="space-y-2">
      <input type="hidden" name="itemId" value={itemId} />
      <label htmlFor="notes" className="flex items-center gap-1.5 text-sm font-medium">
        <NotebookPen className="size-4" /> Note personali (markdown)
      </label>
      <Textarea
        id="notes"
        name="notes"
        rows={6}
        defaultValue={notes ?? ""}
        placeholder={"- punto chiave del video\n- **collegamento** utile…"}
        className="font-mono text-[13px]"
      />
      <div className="flex items-center gap-3">
        <Button type="submit" size="sm" variant="secondary" disabled={pending} className="cursor-pointer">
          {pending ? "Salvataggio…" : "Salva note"}
        </Button>
        {state && (
          <p className={state.ok ? "text-xs text-muted-foreground" : "text-xs text-destructive"}>{state.message}</p>
        )}
      </div>
    </form>
  );
}
