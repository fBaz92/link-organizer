import Link from "next/link";

/*
 * Flow: paginazione server-rendered (link, zero JS) che preserva i filtri
 * correnti nei searchParams.
 */
export function Pagination({
  page,
  pageSize,
  total,
  params,
}: {
  page: number;
  pageSize: number;
  total: number;
  params: Record<string, string>;
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (pages <= 1) return null;

  const href = (target: number): string => {
    const search = new URLSearchParams(params);
    if (target > 0) search.set("p", String(target));
    else search.delete("p");
    const query = search.toString();
    return query ? `/?${query}` : "/";
  };

  return (
    <nav className="flex items-center justify-center gap-3 pt-2 text-sm" aria-label="Paginazione">
      {page > 0 ? (
        <Link href={href(page - 1)} className="rounded-md border px-3 py-1.5 hover:bg-accent cursor-pointer">
          ← Precedente
        </Link>
      ) : (
        <span className="rounded-md border px-3 py-1.5 opacity-40">← Precedente</span>
      )}
      <span className="text-muted-foreground">
        pagina {page + 1} di {pages}
      </span>
      {page < pages - 1 ? (
        <Link href={href(page + 1)} className="rounded-md border px-3 py-1.5 hover:bg-accent cursor-pointer">
          Successiva →
        </Link>
      ) : (
        <span className="rounded-md border px-3 py-1.5 opacity-40">Successiva →</span>
      )}
    </nav>
  );
}
