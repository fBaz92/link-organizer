import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowUpRight, Download, Link2, RefreshCw, Tv } from "lucide-react";
import { ITEM_TYPE_LABELS } from "@/core/domain/item";
import { getRuntime } from "@/core/get-runtime";
import { reclassifyAction } from "@/app/actions";
import { fullDate, formatBytes, domainOf, SOURCE_LABELS } from "@/lib/format";
import { youtubeVideoId } from "@/core/url";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { MarkdownView } from "@/components/markdown-view";
import { FlagToggles } from "@/components/flag-toggles";
import { TagEditor } from "@/components/tag-editor";
import { NotesEditor } from "@/components/notes-editor";
import { DeleteButton } from "@/components/delete-button";
import { ItemVideoDownloadButton } from "@/components/item-video-download-button";

/*
 * Flow: pagina dettaglio di un item. Colonna lettura al centro (titolo,
 * descrizione e note passano dal wrapper typeset), barra azioni con flag,
 * apertura originale, download del file e cancellazione. Tutto server-side
 * tranne i piccoli componenti interattivi.
 */
export default async function ItemPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const itemId = Number.parseInt(id, 10);
  if (!Number.isInteger(itemId)) notFound();

  const item = getRuntime().items.getById(itemId);
  if (!item) notFound();

  const domain = domainOf(item.url ?? item.canonicalUrl);
  const isYoutubeVideo = (() => {
    try {
      return Boolean(youtubeVideoId(new URL(item.canonicalUrl ?? item.url ?? "")));
    } catch {
      return false;
    }
  })();

  return (
    <article className="mx-auto max-w-3xl space-y-6">
      {item.thumbnailPath && (
        <div className="relative aspect-video overflow-hidden rounded-xl border bg-muted">
          {/* Route autenticata: <img> nativo perché l'ottimizzatore next/image
              non inoltra i cookie di sessione. */}
          <img
            src={`/api/thumbs/${item.id}`}
            alt=""
            className="absolute inset-0 h-full w-full object-cover"
          />
        </div>
      )}

      <header className="space-y-3">
        <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          <Badge variant="secondary">{ITEM_TYPE_LABELS[item.type]}</Badge>
          {domain && (
            <span className="flex items-center gap-1">
              <Link2 className="size-3.5" aria-hidden />
              {domain}
            </span>
          )}
          <span aria-hidden>·</span>
          <span>via {SOURCE_LABELS[item.source] ?? item.source}</span>
          <span aria-hidden>·</span>
          <time dateTime={item.createdAt.toISOString()}>{fullDate(item.createdAt)}</time>
        </div>

        <h1 className="text-2xl font-bold leading-tight tracking-tight">
          {item.title ?? item.fileName ?? `Item #${item.id}`}
        </h1>

        {item.authorName && item.authorUrl && (
          <Link
            href={`/?autore=${encodeURIComponent(item.authorUrl)}`}
            className="flex w-fit items-center gap-1.5 text-sm font-medium text-muted-foreground transition-colors hover:text-primary cursor-pointer"
          >
            <Tv className="size-4" aria-hidden />
            {item.authorName}
            <span className="text-xs opacity-60">— vedi tutti i suoi item</span>
          </Link>
        )}

        <div className="flex flex-wrap items-center gap-2">
          {(item.url || item.canonicalUrl) && (
            <Button
              render={<a href={item.canonicalUrl ?? item.url} target="_blank" rel="noopener noreferrer" />}
              nativeButton={false}
              size="sm"
            >
              <ArrowUpRight className="size-4" />
              Apri originale
            </Button>
          )}
          {item.filePath && (
            <Button
              render={<a href={`/api/files/${item.id}`} download />}
              nativeButton={false}
              size="sm"
              variant="secondary"
            >
              <Download className="size-4" />
              Scarica file
            </Button>
          )}
          {isYoutubeVideo && !item.filePath && <ItemVideoDownloadButton itemId={item.id} />}
          {item.url && !item.thumbnailPath && (
            <form action={reclassifyAction.bind(null, item.id)}>
              <Button type="submit" size="sm" variant="outline" className="cursor-pointer">
                <RefreshCw className="size-4" />
                Recupera dettagli
              </Button>
            </form>
          )}
          <FlagToggles itemId={item.id} seen={item.seen} starred={item.starred} />
          <DeleteButton itemId={item.id} />
        </div>
      </header>

      {item.description && (
        <section className="rounded-xl border bg-card p-5">
          <h2 className="mb-2 text-sm font-semibold text-muted-foreground">Descrizione</h2>
          <MarkdownView content={item.description} className="max-w-none text-sm" />
        </section>
      )}

      <Separator />

      <section>
        <TagEditor itemId={item.id} tags={item.tags} />
      </section>

      <section className="grid gap-5 lg:grid-cols-2">
        <NotesEditor itemId={item.id} notes={item.notes} />
        {item.notes && (
          <div className="rounded-xl border bg-card p-4">
            <h2 className="mb-2 text-sm font-semibold text-muted-foreground">Anteprima note</h2>
            <MarkdownView content={item.notes} className="max-w-none text-sm" />
          </div>
        )}
      </section>
    </article>
  );
}
