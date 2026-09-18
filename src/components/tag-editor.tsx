"use client";

import { useActionState, useEffect, useRef } from "react";
import { Tag } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { setTagsAction, type ActionResult } from "@/app/actions";

/*
 * Flow: editor dei tag dell'item. I tag viaggiano come lista separata da
 * virgole (normalizzati lato server: minuscolo, senza #, spazi → trattini).
 * useActionState mostra l'esito e l'input si ripristina dopo il salvataggio.
 */
export function TagEditor({ itemId, tags }: { itemId: number; tags: string[] }) {
  const [state, formAction, pending] = useActionState<ActionResult | null, FormData>(setTagsAction, null);
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (state?.ok) formRef.current?.reset();
  }, [state]);

  return (
    <form ref={formRef} action={formAction} className="space-y-2">
      <input type="hidden" name="itemId" value={itemId} />
      <label htmlFor="tags" className="flex items-center gap-1.5 text-sm font-medium">
        <Tag className="size-4" /> Tag
      </label>
      <div className="flex gap-2">
        <Input
          id="tags"
          name="tags"
          defaultValue={tags.join(", ")}
          placeholder="video, guide, rust…"
          autoComplete="off"
        />
        <Button type="submit" variant="secondary" disabled={pending} className="cursor-pointer">
          {pending ? "…" : "Salva"}
        </Button>
      </div>
      {state && <p className={state.ok ? "text-xs text-muted-foreground" : "text-xs text-destructive"}>{state.message}</p>}
    </form>
  );
}
