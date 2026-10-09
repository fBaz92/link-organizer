import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { FileStore } from "./files";

it("streams and atomically publishes concurrent copies of the same file", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "stash-files-"));
  try {
    const bytes = Buffer.alloc(256 * 1024, 42);
    const source = path.join(root, "source.mp4");
    await writeFile(source, bytes);
    const store = new FileStore(root);
    const stored = await Promise.all([
      store.absorbFile(source, "video.mp4"), store.absorbFile(source, "same.mp4"),
    ]);
    expect(stored[0].hash).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(stored[0].size).toBe(bytes.length);
    expect(stored[1].relativePath).toBe(stored[0].relativePath);
    expect(await readFile(store.absolutePath(stored[0].relativePath))).toEqual(bytes);
    expect(await readdir(path.join(root, "files"))).toEqual([path.basename(stored[0].relativePath)]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
