/*
 * Flow: formattazioni per la UI (date relative, dimensioni file, dominio).
 * Funzioni pure, usate sia dalle card sia dalla pagina dettaglio.
 */

export function relativeDate(date: Date): string {
  const diffMs = Date.now() - date.getTime();
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return "ora";
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h`;
  const days = Math.floor(hours / 24);
  if (days < 31) return `${days} g`;
  return date.toLocaleDateString("it-IT", { day: "numeric", month: "short", year: "numeric" });
}

export function fullDate(date: Date): string {
  return date.toLocaleString("it-IT", { dateStyle: "long", timeStyle: "short" });
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}

export function domainOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return undefined;
  }
}

export const SOURCE_LABELS: Record<string, string> = {
  telegram: "Telegram",
  web: "Web",
  import: "Import",
};
