"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useTransition } from "react";
import { RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ITEM_TYPES, ITEM_TYPE_LABELS } from "@/core/domain/item";
import type { ItemFacets } from "@/db/repositories/items";

/*
 * Flow: barra dei filtri a faccette dinamiche. La pagina (server) calcola i
 * conteggi per dimensione SKIPPANDO il filtro proprio: ogni select mostra
 * quindi le opzioni che producono davvero risultati datogli gli ALTRI filtri
 * attivi (es. con tipo=video, la select Canale elenca solo canali con video).
 *
 * Se la selezione corrente non compare tra le opzioni (combinazione che
 * darebbe 0 risultati) viene iniettata in testa con conteggio 0, così la
 * select mostra sempre un'etichetta sensata invece dell'URL/valore nudo.
 * Il bottone "Azzera filtri" riporta l'URL allo stato pulito.
 */

const FILTER_KEYS = ["q", "tipo", "tag", "autore", "stato", "p"] as const;

interface FacetOption {
  value: string;
  label: string;
}

function withCurrentOption(options: FacetOption[], current: string | null, make: (value: string) => FacetOption): FacetOption[] {
  if (!current || options.some((option) => option.value === current)) return options;
  return [make(current), ...options];
}

export function FiltersBar({ facets }: { facets: ItemFacets }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [pending, startTransition] = useTransition();

  const setParam = (key: string, value: string) => {
    const params = new URLSearchParams(searchParams.toString());
    if (value === "tutti") params.delete(key);
    else params.set(key, value);
    params.delete("p"); // nuovo filtro → torniamo alla prima pagina
    startTransition(() => router.push(`/?${params.toString()}`));
  };

  const clearAll = () => {
    startTransition(() => router.push("/"));
  };

  const hasActiveFilters = FILTER_KEYS.some((key) => searchParams.get(key) !== null);

  const tipo = searchParams.get("tipo");
  const tipoOptions = withCurrentOption(
    ITEM_TYPES.filter((type) => facets.types.some((t) => t.type === type)).map((type) => ({
      value: type,
      label: `${ITEM_TYPE_LABELS[type]} (${facets.types.find((t) => t.type === type)?.count ?? 0})`,
    })),
    tipo,
    (value) => ({ value, label: `${ITEM_TYPE_LABELS[value as keyof typeof ITEM_TYPE_LABELS] ?? value} (0)` }),
  );

  const tag = searchParams.get("tag");
  const tagOptions = withCurrentOption(
    facets.tags.map((t) => ({ value: t.name, label: `#${t.name} (${t.count})` })),
    tag,
    (value) => ({ value, label: `#${value} (0)` }),
  );

  const autore = searchParams.get("autore");
  const authorOptions = withCurrentOption(
    facets.authors.map((a) => ({ value: a.url, label: `${a.name} (${a.count})` })),
    autore,
    (value) => ({ value, label: `${value} (0)` }),
  );

  const states = facets.states;
  const stato = searchParams.get("stato");
  const statoOptions: FacetOption[] = [
    { value: "davedere", label: `Da vedere (${states.unseen})` },
    { value: "visti", label: `Visti (${states.seen})` },
    { value: "preferiti", label: `⭐ Preferiti (${states.starred})` },
  ];

  return (
    <div className={pending ? "flex flex-wrap items-end gap-3 opacity-60" : "flex flex-wrap items-end gap-3"} role="group" aria-label="Filtri">
      <FilterSelect
        title="Tipo"
        ariaLabel="Filtra per tipo"
        value={tipo ?? "tutti"}
        onValueChange={(value) => setParam("tipo", value ?? "tutti")}
        allLabel="Tutti i tipi"
        options={tipoOptions}
      />

      <FilterSelect
        title="Tag"
        ariaLabel="Filtra per tag"
        value={tag ?? "tutti"}
        onValueChange={(value) => setParam("tag", value ?? "tutti")}
        allLabel="Tutti i tag"
        options={tagOptions}
      />

      <FilterSelect
        title="Canale"
        ariaLabel="Filtra per canale"
        value={autore ?? "tutti"}
        onValueChange={(value) => setParam("autore", value ?? "tutti")}
        allLabel="Tutti i canali"
        options={authorOptions}
        hidden={authorOptions.length === 0}
      />

      <FilterSelect
        title="Stato"
        ariaLabel="Filtra per stato"
        value={stato ?? "tutti"}
        onValueChange={(value) => setParam("stato", value ?? "tutti")}
        allLabel={`Tutti (${states.unseen + states.seen})`}
        options={statoOptions}
      />

      {hasActiveFilters && (
        <Button
          variant="outline"
          size="sm"
          onClick={clearAll}
          disabled={pending}
          className="cursor-pointer text-muted-foreground"
          title="Rimuove tutti i filtri e la ricerca"
        >
          <RotateCcw className="size-3.5" />
          Azzera filtri
        </Button>
      )}
    </div>
  );
}

interface FilterSelectProps {
  title: string;
  ariaLabel: string;
  value: string;
  onValueChange: (value: string | null) => void;
  allLabel: string;
  options: FacetOption[];
  hidden?: boolean;
}

function FilterSelect({ title, ariaLabel, value, onValueChange, allLabel, options, hidden }: FilterSelectProps) {
  if (hidden) return null;
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs font-medium text-muted-foreground">{title}</span>
      <Select value={value} onValueChange={onValueChange}>
        <SelectTrigger className="h-9 w-[150px] cursor-pointer" aria-label={ariaLabel}>
          <SelectValue placeholder={title} />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="tutti">{allLabel}</SelectItem>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
