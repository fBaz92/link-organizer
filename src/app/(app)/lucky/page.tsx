import Link from "next/link";
import { randomBytes } from "node:crypto";
import { Dices } from "lucide-react";
import { isItemType, ITEM_TYPES, ITEM_TYPE_LABELS, type ItemType } from "@/core/domain/item";
import { getRuntime } from "@/core/runtime";
import { ItemCard } from "@/components/item-card";
import { EmptyState } from "@/components/empty-state";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/*
 * Flow: "Mi sento fortunato" — 10 item a caso (ORDER BY RANDOM()), filtrabili
 * per tag e tipo. Di default estrae SOLO tra i non visti (la fortuna serve a
 * riscoprire); se il pool filtrato è vuoto riprova sull'intero archivio e lo
 * dice. Tutto server-side: i filtri sono link, "Rimischia" è un link con
 * nonce r= che cambia il rendering (nuova estrazione).
 */

const LUCKY_COUNT = 10;

interface LuckyParams {
  tag?: string;
  tipo?: string;
  visti?: string;
  r?: string;
}

export default async function LuckyPage({
  searchParams,
}: {
  searchParams: Promise<LuckyParams>;
}) {
  const params: LuckyParams = await searchParams;
  const tag = params.tag;
  const tipo = params.tipo && isItemType(params.tipo) ? (params.tipo as ItemType) : undefined;
  const includeSeen = params.visti === "1";

  const runtime = getRuntime();
  let items = runtime.items.random({ tag, type: tipo, seen: includeSeen ? undefined : false }, LUCKY_COUNT);
  let fellBackToAll = false;
  if (items.length === 0 && !includeSeen) {
    items = runtime.items.random({ tag, type: tipo }, LUCKY_COUNT);
    fellBackToAll = true;
  }

  const tags = runtime.items.tagsWithCounts().slice(0, 15);
  const reroll = randomBytes(4).toString("hex");

  const hrefWith = (overrides: Partial<LuckyParams>): string => {
    const next = new URLSearchParams();
    const merged = { tag, tipo, visti: includeSeen ? "1" : undefined, ...overrides };
    if (merged.tag) next.set("tag", merged.tag);
    if (merged.tipo) next.set("tipo", merged.tipo);
    if (merged.visti) next.set("visti", merged.visti);
    const query = next.toString();
    return query ? `/lucky?${query}` : "/lucky";
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-bold">
            <Dices className="size-5 text-primary" />
            Mi sento fortunato
          </h1>
          <p className="text-sm text-muted-foreground">
            {includeSeen ? "Estrazione da tutto l'archivio." : "Estrazione tra gli item non ancora visti."}
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            render={<Link href={hrefWith({ visti: includeSeen ? undefined : "1", r: reroll })} />}
            nativeButton={false}
            variant="outline"
            size="sm"
            className="cursor-pointer"
          >
            {includeSeen ? "Solo non visti" : "Includi visti"}
          </Button>
          <Button
            render={<Link href={hrefWith({ r: reroll })} />}
            nativeButton={false}
            size="sm"
            className="cursor-pointer"
          >
            <Dices className="size-4" />
            Rimischia
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap gap-1.5" role="group" aria-label="Filtri estrazione">
        <FilterChip href={hrefWith({ tag: undefined, r: reroll })} active={!tag}>
          tutti i tag
        </FilterChip>
        {tags.map((tagItem) => (
          <FilterChip key={tagItem.name} href={hrefWith({ tag: tagItem.name, r: reroll })} active={tag === tagItem.name}>
            #{tagItem.name}
          </FilterChip>
        ))}
        <span className="mx-1 w-px self-stretch bg-border" aria-hidden />
        <FilterChip href={hrefWith({ tipo: undefined, r: reroll })} active={!tipo}>
          ogni tipo
        </FilterChip>
        {ITEM_TYPES.map((type) => (
          <FilterChip key={type} href={hrefWith({ tipo: type, r: reroll })} active={tipo === type}>
            {ITEM_TYPE_LABELS[type]}
          </FilterChip>
        ))}
      </div>

      {items.length === 0 ? (
        <EmptyState title="Archivio vuoto." hint="Archivia qualcosa prima di tentare la fortuna." />
      ) : (
        <>
          {fellBackToAll && (
            <p className="text-sm text-amber-600 dark:text-amber-400">
              Nessun inedito con questi filtri: ho pescato dall&apos;intero archivio.
            </p>
          )}
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {items.map((item, index) => (
              <ItemCard key={item.id} item={item} priority={index < 6} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function FilterChip({ href, active, children }: { href: string; active: boolean; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      className={cn(
        "rounded-full border px-3 py-1 text-xs font-medium transition-colors cursor-pointer",
        active ? "border-primary bg-primary/10 text-primary" : "text-muted-foreground hover:bg-accent",
      )}
    >
      {children}
    </Link>
  );
}
