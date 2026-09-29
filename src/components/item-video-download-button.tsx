"use client";

import { useState, useTransition } from "react";
import { Send } from "lucide-react";
import { startVideoDownloadByItemAction } from "@/app/actions";
import { Button } from "@/components/ui/button";
import { VideoJobStatus } from "@/components/video-job-status";

/*
 * Flow: bottone "Scarica e invia su Telegram" per i video YouTube nella
 * pagina dettaglio. Avvia lo stesso job del wizard (il servizio salta il
 * download se il file è già nello store) e mostra l'avanzamento sotto la
 * barra delle azioni.
 */
export function ItemVideoDownloadButton({ itemId }: { itemId: number }) {
  const [jobId, setJobId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const start = (): void => {
    setMessage(null);
    startTransition(async () => {
      const result = await startVideoDownloadByItemAction(itemId);
      if (!result.ok) {
        setMessage(result.message);
        return;
      }
      setJobId(result.jobId ?? null);
    });
  };

  return (
    <div className="contents">
      <Button type="button" size="sm" variant="secondary" onClick={start} disabled={pending} className="cursor-pointer">
        <Send className="size-4" />
        {pending ? "…" : "Su Telegram"}
      </Button>
      {(jobId || message) && (
        <div className="w-full">
          {message && <p className="text-sm text-destructive">{message}</p>}
          {jobId && <VideoJobStatus jobId={jobId} onClear={() => setJobId(null)} />}
        </div>
      )}
    </div>
  );
}
