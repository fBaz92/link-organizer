import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, copyFile, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

/*
 * Flow: lo store dei file binari (PDF e vari inviati al bot, thumbnail,
 * file importati). Tutto vive sotto DATA_DIR con path RELATIVI nel DB
 * ("files/<hash>.<ext>", "thumbs/<hash>.jpg") così la cartella dati può
 * essere spostata senza riscrivere il database.
 *
 * Chiave di dedup = sha256 dei byte: due upload identici finiscono sullo
 * stesso file e sullo stesso hash → IngestionService li rifiuta come duplicati.
 */

export interface StoredFile {
  /** Percorso relativo a DATA_DIR. */
  relativePath: string;
  fileName: string;
  hash: string;
  size: number;
}

const MAX_FILE_BYTES = 2 * 1024 * 1024 * 1024; // 2 GB: tetto difensivo, non una policy

export class FileStore {
  constructor(private readonly rootDir: string) {}

  /** Cartella assoluta di un path relativo allo store. */
  absolutePath(relativePath: string): string {
    return path.join(this.rootDir, relativePath);
  }

  async saveBytes(bytes: Uint8Array, originalName: string, subdir: "files" | "thumbs"): Promise<StoredFile> {
    const hash = createHash("sha256").update(bytes).digest("hex");
    const target = path.join(subdir, `${hash}${safeExtension(originalName)}`);
    const absolute = this.absolutePath(target);
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, bytes);
    return {
      relativePath: target,
      fileName: sanitizeFileName(originalName),
      hash,
      size: bytes.byteLength,
    };
  }

  async saveFromSourceFile(sourcePath: string, originalName: string, subdir: "files" | "thumbs"): Promise<StoredFile> {
    const digest = createHash("sha256");
    let size = 0;
    for await (const chunk of createReadStream(sourcePath)) {
      size += chunk.length;
      this.assertReasonableSize(size);
      digest.update(chunk);
    }
    const hash = digest.digest("hex");
    const target = path.join(subdir, `${hash}${safeExtension(originalName)}`);
    const absolute = this.absolutePath(target);
    await mkdir(path.dirname(absolute), { recursive: true });
    const staged = `${absolute}.${randomUUID()}.tmp`;
    try {
      await copyFile(sourcePath, staged);
      await rename(staged, absolute);
    } finally { await rm(staged, { force: true }); }
    return { relativePath: target, fileName: sanitizeFileName(originalName), hash, size };
  }

  /** Usato dal bot e dall'import: sposta il file nello store e ne calcola l'hash. */
  async absorbFile(sourcePath: string, originalName: string): Promise<StoredFile> {
    return this.saveFromSourceFile(sourcePath, originalName, "files");
  }

  async readBytes(relativePath: string): Promise<Uint8Array> {
    const bytes = await readFile(this.absolutePath(relativePath));
    return new Uint8Array(bytes);
  }

  async deleteStoredFile(relativePath: string): Promise<void> {
    await rm(this.absolutePath(relativePath), { force: true });
  }

  async copyInto(relativePath: string, destination: string): Promise<void> {
    await copyFile(this.absolutePath(relativePath), destination);
  }

  assertReasonableSize(size: number): void {
    if (size > MAX_FILE_BYTES) {
      throw new Error(`File troppo grande (${size} byte, limite ${MAX_FILE_BYTES})`);
    }
  }
}

function safeExtension(name: string): string {
  const ext = path.extname(name).toLowerCase();
  return /^\.[a-z0-9]{1,12}$/.test(ext) ? ext : "";
}

function sanitizeFileName(name: string): string {
  return path.basename(name).replace(/[\u0000-\u001f/\\]/g, "_").slice(0, 255) || "file";
}
