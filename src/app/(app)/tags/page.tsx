import Link from "next/link";
import { Tag } from "lucide-react";
import { getRuntime } from "@/core/get-runtime";
import { EmptyState } from "@/components/empty-state";

/*
 * Flow: panoramica dei tag con conteggi, ogni tag rimanda all'archivio
 * filtrato. Server component puro.
 */
export default async function TagsPage() {
  const tags = getRuntime().items.tagsWithCounts();

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-bold">Tag</h1>
        <p className="text-sm text-muted-foreground">{tags.length} tag assegnati dall&apos;archivio.</p>
      </div>

      {tags.length === 0 ? (
        <EmptyState title="Ancora nessun tag." hint="I tag nascono dalle regole di classificazione o li aggiungi tu." />
      ) : (
        <div className="flex flex-wrap gap-2">
          {tags.map((tag) => (
            <Link
              key={tag.name}
              href={`/?tag=${encodeURIComponent(tag.name)}`}
              className="flex items-center gap-1.5 rounded-full border px-3.5 py-1.5 text-sm transition-colors hover:border-primary/40 hover:bg-accent cursor-pointer"
            >
              <Tag className="size-3.5 text-muted-foreground" aria-hidden />
              {tag.name}
              <span className="rounded-full bg-muted px-1.5 text-xs text-muted-foreground">{tag.count}</span>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
