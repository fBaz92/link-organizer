/*
 * Flow: tipi fondanti del dominio condivisi da web, bot e import. Un Item è
 * l'unità archivistica: un link e/o un file, classificato con un tipo e dei
 * tag. ITEM_TYPE_LABELS è la traduzione per la UI (e il bot), in un posto
 * solo così italiano e codice non divergono.
 */

export const ITEM_TYPES = [
  "video",
  "articolo",
  "post",
  "repo",
  "paper",
  "documento",
  "podcast",
  "musica",
  "link",
] as const;

export type ItemType = (typeof ITEM_TYPES)[number];

export const ITEM_TYPE_LABELS: Record<ItemType, string> = {
  video: "Video",
  articolo: "Articolo",
  post: "Post",
  repo: "Repo",
  paper: "Paper",
  documento: "Documento",
  podcast: "Podcast",
  musica: "Musica",
  link: "Link",
};

export function isItemType(value: string): value is ItemType {
  return (ITEM_TYPES as readonly string[]).includes(value);
}

export const ITEM_SOURCES = ["telegram", "web", "import"] as const;
export type ItemSource = (typeof ITEM_SOURCES)[number];

/** Riferimento opzionale al messaggio Telegram che ha originato l'item. */
export interface SourceRef {
  chatId?: string;
  messageId?: number;
}

/** L'item come lo vede tutta l'applicazione (UI, bot, test). */
export interface Item {
  id: number;
  type: ItemType;
  url?: string;
  canonicalUrl?: string;
  title?: string;
  description?: string;
  notes?: string;
  thumbnailPath?: string;
  filePath?: string;
  fileName?: string;
  mimeType?: string;
  source: ItemSource;
  sourceRef?: SourceRef;
  /** Canale/autore dell'item (es. canale YouTube), se noto dai metadati. */
  authorName?: string;
  authorUrl?: string;
  seen: boolean;
  starred: boolean;
  tags: string[];
  createdAt: Date;
  updatedAt: Date;
}
