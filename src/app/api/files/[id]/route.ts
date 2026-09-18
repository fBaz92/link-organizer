import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { isAuthenticated } from "@/lib/auth";
import { getRuntime } from "@/core/runtime";

/*
 * Flow: download del file associato a un item. Route autenticata (stessa
 * sessione della web UI): il file NON è esposto staticamente, il path nel
 * DB è relativo a DATA_DIR e viene risolto dal FileStore. Il body è uno
 * stream Node convertito in Web Stream: niente buffer in memoria.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  if (!(await isAuthenticated())) return new Response("Non autorizzato", { status: 401 });

  const { id } = await params;
  const item = getRuntime().items.getById(Number.parseInt(id, 10));
  if (!item?.filePath || !item.fileName) return new Response("Non trovato", { status: 404 });

  const { files } = getRuntime();
  const absolute = files.absolutePath(item.filePath);
  try {
    await stat(absolute);
  } catch {
    return new Response("File non disponibile", { status: 404 });
  }

  const stream = Readable.toWeb(createReadStream(absolute)) as ReadableStream<Uint8Array>;
  return new Response(stream, {
    headers: {
      "content-type": item.mimeType ?? "application/octet-stream",
      "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(item.fileName)}`,
      "cache-control": "private, no-store",
    },
  });
}
