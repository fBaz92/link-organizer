"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { Clock, Download, Search, Send, Tv } from "lucide-react";
import {
  searchArchiveVideosAction,
  startVideoDownloadByItemAction,
  startVideoDownloadByUrlAction,
  type VideoSearchHit,
} from "@/app/actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { VideoJobStatus } from "@/components/video-job-status";

/*
 * Flow: wizard "Scarica video" della web UI. Tre vie d'accesso allo stesso
 * servizio: link YouTube incollato (crea l'item se manca), ultimi 20 video
 * archiviati, ricerca per parola chiave con ranking "simile" (max 30).
 * La scelta avvia un job in background: il pannello di avanzamento polla
 * la stato e l'arrivo in chat Telegram è l'ultimo passo del job stesso.
 */

export function DownloadWizard({ recent }: { recent: VideoSearchHit[] }) {
  const [jobId, setJobId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [urlValue, setUrlValue] = useState("");
  const [keyword, setKeyword] = useState("");
  const [keywordResults, setKeywordResults] = useState<VideoSearchHit[] | null>(null);
  const [pending, startTransition] = useTransition();
  const [searching, setSearching] = useState(false);

  const startFromUrl = (): void => {
    const url = urlValue.trim();
    if (!url) return;
    setMessage(null);
    startTransition(async () => {
      const result = await startVideoDownloadByUrlAction(url);
      if (!result.ok) {
        setMessage(result.message);
        return;
      }
      setJobId(result.jobId ?? null);
      setUrlValue("");
    });
  };

  const startFromItem = (itemId: number): void => {
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

  const runSearch = (): void => {
    const q = keyword.trim();
    if (q.length < 2) return;
    setSearching(true);
    setKeywordResults(null);
    void searchArchiveVideosAction(q)
      .then((hits) => setKeywordResults(hits))
      .finally(() => setSearching(false));
  };

  return (
    <div className="space-y-6">
      {/* Via rapida: link incollato */}
      <section className="space-y-2">
        <h2 className="text-sm font-semibold">Hai già il link?</h2>
        <div className="flex gap-2">
          <Input
            type="url"
            inputMode="url"
            placeholder="https://www.youtube.com/watch?v=…"
            value={urlValue}
            onChange={(event) => setUrlValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                startFromUrl();
              }
            }}
            aria-label="Link YouTube da scaricare"
          />
          <Button type="button" onClick={startFromUrl} disabled={pending || urlValue.trim() === ""} className="cursor-pointer">
            <Download className="size-4" />
            {pending ? "…" : "Scarica"}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          Il video viene archiviato in Stash, scaricato (max 720p) e inviato in chat Telegram; se supera i ~50 MB arriva spezzettato in più parti.
        </p>
      </section>

      {message && <p className="text-sm text-destructive">{message}</p>}
      {jobId && <VideoJobStatus jobId={jobId} onClear={() => setJobId(null)} />}

      {/* Wizard sull'archivio */}
      <Tabs defaultValue={0}>
        <TabsList>
          <TabsTrigger value={0}>
            <Clock className="size-3.5" />
            Ultimi 20 video
          </TabsTrigger>
          <TabsTrigger value={1}>
            <Search className="size-3.5" />
            Parola chiave
          </TabsTrigger>
        </TabsList>

        <TabsContent value={0} className="mt-4">
          {recent.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Nessun video YouTube in archivio: mandane uno al bot o incolla il link qui sopra.
            </p>
          ) : (
            <VideoList hits={recent} onDownload={startFromItem} pending={pending} />
          )}
        </TabsContent>

        <TabsContent value={1} className="mt-4 space-y-3">
          <div className="flex gap-2">
            <Input
              type="search"
              placeholder="Es. rust tutorial, grid forming…"
              value={keyword}
              onChange={(event) => setKeyword(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  runSearch();
                }
              }}
              aria-label="Parola chiave da cercare tra i video archiviati"
            />
            <Button type="button" variant="secondary" onClick={runSearch} disabled={searching || keyword.trim().length < 2} className="cursor-pointer">
              <Search className="size-4" />
              {searching ? "…" : "Cerca"}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            La ricerca è «simile»: tollera refusi e prefissi, guarda titolo, canale e tag. Massimo 30 risultati.
          </p>
          {keywordResults !== null &&
            (keywordResults.length === 0 ? (
              <p className="text-sm text-muted-foreground">Nessun video simile a «{keyword.trim()}».</p>
            ) : (
              <VideoList hits={keywordResults} onDownload={startFromItem} pending={pending} />
            ))}
        </TabsContent>
      </Tabs>
    </div>
  );
}

function VideoList({
  hits,
  onDownload,
  pending,
}: {
  hits: VideoSearchHit[];
  onDownload: (itemId: number) => void;
  pending: boolean;
}) {
  return (
    <ul className="divide-y rounded-xl border bg-card">
      {hits.map((hit) => (
        <li key={hit.id} className="flex items-center gap-3 p-3">
          {hit.thumbUrl && (
            // eslint-disable-next-line @next/next/no-img-element -- thumbnail remota/locali autenticate, niente ottimizzatore
            <img
              src={hit.thumbUrl}
              alt=""
              loading="lazy"
              className="aspect-video w-24 shrink-0 rounded-md border object-cover sm:w-28"
            />
          )}
          <div className="min-w-0 flex-1">
            <Link
              href={`/item/${hit.id}`}
              className="line-clamp-2 text-sm font-semibold leading-snug hover:text-primary"
              title={hit.title}
            >
              {hit.title}
            </Link>
            <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
              {hit.channel && (
                <span className="flex min-w-0 items-center gap-1">
                  <Tv className="size-3 shrink-0" aria-hidden />
                  <span className="truncate">{hit.channel}</span>
                </span>
              )}
              {hit.score !== undefined && (
                <span className="rounded-full bg-primary/10 px-1.5 py-0.5 font-semibold text-primary">
                  {Math.round(hit.score * 100)}%
                </span>
              )}
              {hit.downloaded && <span className="rounded-md bg-muted px-1.5 py-0.5">già in archivio</span>}
            </div>
          </div>
          <Button
            type="button"
            size="sm"
            variant="secondary"
            onClick={() => onDownload(hit.id)}
            disabled={pending}
            className="shrink-0 cursor-pointer"
          >
            <Send className="size-3.5" />
            Scarica
          </Button>
        </li>
      ))}
    </ul>
  );
}
