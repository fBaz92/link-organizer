import Image from "next/image";
import Link from "next/link";
import { FileText, Star, Tv } from "lucide-react";
import type { Item } from "@/core/domain/item";
import { ITEM_TYPE_LABELS } from "@/core/domain/item";
import { youtubeThumbnailUrl } from "@/core/url";
import { Badge } from "@/components/ui/badge";
import { domainOf, relativeDate } from "@/lib/format";
import { cn } from "@/lib/utils";

/*
 * Flow: card di un item nell'archivio (server component).
 *
 * Due varianti dallo stesso schema "stretch link": la card è un contenitore
 * relativo e il link al dettaglio si stende su tutta la superficie
 * (after:absolute after:inset-0), così l'unica cosa davvero cliccabile
 * sopra è il canale (relative z-10) — il resto porta al dettaglio.
 *
 * - Con anteprima disponibile (thumbnail locale o, per i video YouTube,
 *   il fallback su i.ytimg.com) → card verticale con anteprima 16:9.
 * - Senza anteprima → card orizzontale compatta con icona per tipo.
 * - Il canale (author_name), se noto, rimanda all'archivio filtrato.
 */
export function ItemCard({ item, priority = false }: { item: Item; priority?: boolean }) {
  const localThumb = item.thumbnailPath ? `/api/thumbs/${item.id}` : undefined;
  const youtubeThumb = item.type === "video" ? youtubeThumbnailUrl(item.canonicalUrl ?? item.url ?? "") : null;
  const thumbSrc = localThumb ?? youtubeThumb ?? undefined;
  const domain = domainOf(item.url ?? item.canonicalUrl);
  const channelHref = item.authorUrl ? `/?autore=${encodeURIComponent(item.authorUrl)}` : undefined;

  const title = item.title ?? item.fileName ?? `Item #${item.id}`;
  const meta = (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
      <Badge variant="secondary" className="px-1.5 py-0">
        {ITEM_TYPE_LABELS[item.type]}
      </Badge>
      {domain && <span className="truncate">{domain}</span>}
      <span aria-hidden>·</span>
      <span className="whitespace-nowrap">{relativeDate(item.createdAt)}</span>
      {!item.seen && (
        <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-semibold text-primary">nuovo</span>
      )}
    </div>
  );

  const tagsRow =
    item.tags.length > 0 ? (
      <div className="flex flex-wrap gap-1 pt-0.5" aria-label="Tag">
        {item.tags.slice(0, 4).map((tag) => (
          <span key={tag} className="rounded-md bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
            #{tag}
          </span>
        ))}
      </div>
    ) : null;

  const body = (
    <>
      {item.authorName && channelHref && (
        <a
          href={channelHref}
          className="relative z-10 flex w-fit items-center gap-1 text-xs font-medium text-muted-foreground transition-colors hover:text-primary cursor-pointer"
        >
          <Tv className="size-3.5" aria-hidden />
          {item.authorName}
        </a>
      )}
      {meta}
      {tagsRow}
    </>
  );

  if (thumbSrc) {
    return (
      <div className="group relative flex flex-col overflow-hidden rounded-xl border bg-card transition-colors hover:border-primary/40">
        <div className="relative aspect-video w-full bg-muted">
          {/*
            Le thumbnail LOCALI passano da una route autenticata: next/image
            non inoltra i cookie nella fetch interna dell'ottimizzatore →
            usiamo <img> nativo (stessa origine, cookie inclusi). Il fallback
            esterno YouTube resta su next/image con remotePatterns.
          */}
          {localThumb ? (
            <img
              src={localThumb}
              alt=""
              loading={priority ? "eager" : "lazy"}
              className="absolute inset-0 h-full w-full object-cover"
            />
          ) : (
            <Image
              src={thumbSrc}
              alt=""
              fill
              sizes="(min-width: 1280px) 380px, (min-width: 640px) 340px, 100vw"
              priority={priority}
              className="object-cover"
            />
          )}
        </div>
        <div className="flex flex-1 flex-col gap-1 p-3">
          <TitleLink itemId={item.id} title={title} starred={item.starred} />
          {body}
        </div>
      </div>
    );
  }

  return (
    <div className="group relative flex gap-3 self-start rounded-xl border bg-card p-3 transition-colors hover:border-primary/40">
      <div className="relative size-20 shrink-0 overflow-hidden rounded-lg border bg-muted sm:size-24">
        <div className="flex h-full items-center justify-center text-muted-foreground">
          <FileText className="size-6" aria-hidden />
        </div>
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <TitleLink itemId={item.id} title={title} starred={item.starred} />
        {body}
      </div>
    </div>
  );
}

/** Il link al dettaglio si estende su tutta la card (pattern stretch-link);
 * la stella preferito viaggia accanto al titolo. */
function TitleLink({ itemId, title, starred }: { itemId: number; title: string; starred: boolean }) {
  return (
    <div className="flex items-start justify-between gap-2">
      <h3>
        <Link
          href={`/item/${itemId}`}
          className="after:absolute after:inset-0 after:z-0 line-clamp-2 text-sm font-semibold leading-snug text-foreground group-hover:text-primary"
        >
          {title}
        </Link>
      </h3>
      {starred && <Star className="size-4 shrink-0 fill-amber-400 text-amber-400" aria-label="Preferito" />}
    </div>
  );
}
