"use client";

import { useActionState, useEffect, useRef } from "react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Plus } from "lucide-react";
import { addLinkAction, addFileAction, type ActionResult } from "@/app/actions";

/*
 * Flow: dialog "Aggiungi" della web UI. Due form indipendenti che passano
 * dalle stesse server action del dominio: link (ingestione + metadati
 * sincroni) o file upload (hash + dedup). useActionState porta il feedback
 * nell'interfaccia; in caso di successo il form si azzera.
 */
export function AddDialog() {
  const [linkState, linkFormAction, linkPending] = useActionState<ActionResult | null, FormData>(addLinkAction, null);
  const [fileState, fileFormAction, filePending] = useActionState<ActionResult | null, FormData>(addFileAction, null);
  const linkFormRef = useRef<HTMLFormElement>(null);
  const fileFormRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (linkState?.ok) linkFormRef.current?.reset();
  }, [linkState]);
  useEffect(() => {
    if (fileState?.ok) fileFormRef.current?.reset();
  }, [fileState]);

  return (
    <Dialog>
      <DialogTrigger
        render={
          <Button size="sm" className="cursor-pointer">
            <Plus className="size-4" />
            Aggiungi
          </Button>
        }
      />
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Aggiungi all&apos;archivio</DialogTitle>
          <DialogDescription>
            Un link o un file: Stash lo classifica, lo deduplica e lo indicizza.
          </DialogDescription>
        </DialogHeader>

        <form ref={linkFormRef} action={linkFormAction} className="space-y-2">
          <Label htmlFor="add-url">Link</Label>
          <div className="flex gap-2">
            <Input
              id="add-url"
              name="url"
              type="url"
              placeholder="https://youtu.be/…"
              required
              autoComplete="off"
            />
            <Button type="submit" disabled={linkPending} className="cursor-pointer">
              {linkPending ? "…" : "Salva"}
            </Button>
          </div>
          {linkState && (
            <p className={linkState.ok ? "text-sm text-primary" : "text-sm text-destructive"}>{linkState.message}</p>
          )}
        </form>

        <Separator />

        <form ref={fileFormRef} action={fileFormAction} className="space-y-2">
          <Label htmlFor="add-file">File (PDF, documenti, archivi…)</Label>
          <div className="flex gap-2">
            <Input id="add-file" name="file" type="file" required />
            <Button type="submit" variant="secondary" disabled={filePending} className="cursor-pointer">
              {filePending ? "…" : "Carica"}
            </Button>
          </div>
          {fileState && (
            <p className={fileState.ok ? "text-sm text-primary" : "text-sm text-destructive"}>{fileState.message}</p>
          )}
        </form>
      </DialogContent>
    </Dialog>
  );
}
