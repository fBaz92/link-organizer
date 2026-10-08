import Link from "next/link";
import { X } from "lucide-react";
import { isItemType, type ItemType } from "@/core/domain/item";
import { getRuntime } from "@/core/get-runtime";
import { ItemCard } from "@/components/item-card";
import { FiltersBar } from "@/components/filters-bar";
import { Pagination } from "@/components/pagination";
import { EmptyState } from "@/components/empty-state";

/*
 * Flow: pagina Archivio. Server component: legge i filtri dai searchParams
 * (l'URL è la verità — q, tipo, tag, autore, stato, pagina), interroga il
 * repository e renderizza filtri + card + paginazione. I filtri attivi
 * (ricerca e canale) compaiono come chip removibili sopra la griglia.
 */

const PAGE_SIZE = 24;

interface ArchiveParams {
  q?: string;
  tipo?: string;
  tag?: string;
  autore?: string;
  stato?: string;
  p?: string;
}

export default async function ArchivePage({
  searchParams,
}: {
  searchParams: Promise<ArchiveParams>;
}) {
  const params = await searchParams;
  const q = params.q?.trim();
  const tipo = params.tipo;
  const tag = params.tag;
  const autore = params.autore;
  const stato = params.stato;
  const page = Math.max(0, Number.parseInt(params.p ?? "0", 10) || 0);

  const filters = {
    q: q || undefined,
    type: tipo && isItemType(tipo) ? (tipo as ItemType) : undefined,
    tag: tag || undefined,
    author: autore || undefined,
    seen: stato === "visti" ? true : stato === "davedere" ? false : undefined,
    starred: stato === "preferiti" ? true : undefined,
  };

  const runtime = getRuntime();
  const { items, total } = runtime.items.list({ ...filters, limit: PAGE_SIZE, offset: page * PAGE_SIZE });
  const facets = runtime.items.facets(filters);
  const authorName = autore
    ? (runtime.items.authorsWithCounts().find((a) => a.url === autore)?.name ?? autore)
    : undefined;

  const currentParams: Record<string, string> = {};
  if (q) currentParams.q = q;
  if (tipo) currentParams.tipo = tipo;
  if (tag) currentParams.tag = tag;
  if (autore) currentParams.autore = autore;
  if (stato) currentParams.stato = stato;

  const chipHrefWithout = (key: string): string => {
    const rest = new URLSearchParams(currentParams);
    rest.delete(key);
    rest.delete("p");
    const query = rest.toString();
    return query ? `/?${query}` : "/";
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold">Archivio</h1>
          <p className="text-sm text-muted-foreground">
            {q ? `${total} risultati per «${q}»` : `${total} item archiviati`}
          </p>
        </div>
        <FiltersBar facets={facets} />
      </div>

      {(q || authorName) && (
        <div className="flex flex-wrap items-center gap-2">
          {q && (
            <ActiveFilterChip href={chipHrefWithout("q")} label={`ricerca: ${q}`} />
          )}
          {authorName && (
            <ActiveFilterChip href={chipHrefWithout("autore")} label={`canale: ${authorName}`} />
          )}
        </div>
      )}

      {items.length === 0 ? (
        <EmptyState
          title="Niente qui."
          hint="Manda un link o un file al bot su Telegram, o usa «Aggiungi» qui sopra."
        />
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {items.map((item, index) => (
              <ItemCard key={item.id} item={item} priority={index < 6} />
            ))}
          </div>
          <Pagination page={page} pageSize={PAGE_SIZE} total={total} params={currentParams} />
        </>
      )}
    </div>
  );
}

function ActiveFilterChip({ href, label }: { href: string; label: string }) {
  return (
    <Link
      href={href}
      className="flex items-center gap-1.5 rounded-full border border-primary/40 bg-primary/10 px-3 py-1 text-xs font-medium text-primary transition-colors hover:bg-primary/20 cursor-pointer"
      title="Rimuovi filtro"
    >
      {label}
      <X className="size-3" aria-hidden />
    </Link>
  );
}
