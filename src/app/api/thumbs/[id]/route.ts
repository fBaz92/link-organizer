import { isAuthenticated } from "@/lib/auth";
import { getRuntime } from "@/core/runtime";

/*
 * Flow: thumbnail di un item (route autenticata — le immagini sono nella
 * cartella dati, non in public). I file hanno nome da hash del contenuto:
 * cache privata aggressiva è sicura ed evita richieste ripetute.
 */
const EXTENSION_TYPES: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  if (!(await isAuthenticated())) return new Response("Non autorizzato", { status: 401 });

  const { id } = await params;
  const item = getRuntime().items.getById(Number.parseInt(id, 10));
  if (!item?.thumbnailPath) return new Response("Non trovato", { status: 404 });

  const { files } = getRuntime();
  let bytes: Uint8Array;
  try {
    bytes = await files.readBytes(item.thumbnailPath);
  } catch {
    return new Response("Immagine non disponibile", { status: 404 });
  }

  const extension = item.thumbnailPath.slice(item.thumbnailPath.lastIndexOf(".")).toLowerCase();
  return new Response(bytes as BodyInit, {
    headers: {
      "content-type": EXTENSION_TYPES[extension] ?? "image/jpeg",
      "cache-control": "private, max-age=31536000, immutable",
    },
  });
}
