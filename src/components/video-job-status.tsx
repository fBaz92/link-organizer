"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AlertCircle, CheckCircle2, Download, Loader2, Scissors, Send, Upload } from "lucide-react";
import { cn } from "@/lib/utils";

/*
 * Flow: stato live di un job di download video. Polla la route autenticata
 * /api/video-jobs/<id> finché il job non termina (done/error) e mostra
 * fase, percentuale ed esito. Al "done" refresha la router tree: l'item ha
 * un file nuovo (bottone "Scarica file" sul dettaglio).
 */

interface JobSnapshot {
  id: string;
  itemId: number | null;
  url: string;
  title: string | null;
  phase: "downloading" | "saving" | "splitting" | "uploading" | "done" | "error";
  progress: number;
  error: string | null;
}

const PHASE_LABELS: Record<JobSnapshot["phase"], string> = {
  downloading: "Download in corso",
  saving: "Salvataggio nell'archivio",
  splitting: "Suddivisione in parti (video oltre 50 MB)",
  uploading: "Invio su Telegram",
  done: "Completato",
  error: "Errore",
};

const POLL_INTERVAL_MS = 1500;

export function VideoJobStatus({ jobId, onClear }: { jobId: string; onClear?: () => void }) {
  const [job, setJob] = useState<JobSnapshot | null>(null);
  const router = useRouter();

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;

    const poll = async (): Promise<void> => {
      try {
        const response = await fetch(`/api/video-jobs/${jobId}`, { cache: "no-store" });
        if (!response.ok) throw new Error(String(response.status));
        const snapshot = (await response.json()) as JobSnapshot;
        if (cancelled) return;
        setJob(snapshot);
        if (snapshot.phase === "done" || snapshot.phase === "error") {
          router.refresh();
          return;
        }
      } catch {
        // fetch fallita: si riprova al prossimo giro
      }
      if (!cancelled) timer = setTimeout(poll, POLL_INTERVAL_MS);
    };

    void poll();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [jobId, router]);

  if (!job) {
    return (
      <div className="flex items-center gap-2 rounded-lg border bg-card p-3 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" aria-hidden />
        Avvio del job…
      </div>
    );
  }

  if (job.phase === "error") {
    return (
      <div className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
        <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden />
        <div className="min-w-0">
          <p className="font-medium">{PHASE_LABELS.error}</p>
          <p className="break-words">{job.error ?? "Errore sconosciuto."}</p>
          {onClear && <ClearLink onClear={onClear} />}
        </div>
      </div>
    );
  }

  if (job.phase === "done") {
    return (
      <div className="flex items-start gap-2 rounded-lg border border-primary/40 bg-primary/10 p-3 text-sm">
        <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="font-medium">Video inviato su Telegram</p>
          <p className="truncate text-muted-foreground">{job.title ?? job.url}</p>
          {job.itemId !== null && (
            <Link href={`/item/${job.itemId}`} className="text-primary underline-offset-4 hover:underline">
              Apri l&apos;item in Stash
            </Link>
          )}
          {onClear && <ClearLink onClear={onClear} />}
        </div>
      </div>
    );
  }

  const icon = job.phase === "uploading" ? Send : job.phase === "saving" ? Upload : job.phase === "splitting" ? Scissors : Download;
  const Icon = icon;

  return (
    <div className="space-y-2 rounded-lg border bg-card p-3">
      <div className="flex items-center justify-between gap-2 text-sm">
        <span className="flex min-w-0 items-center gap-2">
          <Icon className="size-4 shrink-0 animate-pulse text-primary" aria-hidden />
          <span className="truncate font-medium">{job.title ?? job.url}</span>
        </span>
        <span className="shrink-0 text-xs text-muted-foreground">{PHASE_LABELS[job.phase]}</span>
      </div>
      <div
        role="progressbar"
        aria-valuenow={job.progress}
        aria-valuemin={0}
        aria-valuemax={100}
        className="h-1.5 overflow-hidden rounded-full bg-muted"
      >
        <div
          className={cn("h-full rounded-full bg-primary transition-all", job.phase !== "downloading" && "w-full animate-pulse")}
          style={{ width: `${job.phase === "downloading" ? job.progress : 100}%` }}
        />
      </div>
      {job.phase === "downloading" && <p className="text-right text-xs text-muted-foreground">{job.progress}%</p>}
    </div>
  );
}

function ClearLink({ onClear }: { onClear: () => void }) {
  return (
    <button
      type="button"
      onClick={onClear}
      className="mt-1 cursor-pointer text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
    >
      Nascondi
    </button>
  );
}
