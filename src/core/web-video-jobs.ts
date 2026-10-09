import { getRuntime } from "@/core/get-runtime";
import type { StartJobResult, VideoDownloadInput, VideoJobSnapshot } from "@/core/video-download";

async function workerRequest<T>(path: string, input?: VideoDownloadInput): Promise<T> {
  const response = await fetch(`http://127.0.0.1:${process.env.STASH_CONTROL_PORT}${path}`, {
    method: input ? "POST" : "GET",
    headers: { authorization: `Bearer ${process.env.STASH_CONTROL_TOKEN}`, "content-type": "application/json" },
    ...(input ? { body: JSON.stringify(input) } : {}),
    cache: "no-store", signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error("Il processo di elaborazione non è disponibile. Riprova tra poco.");
  return response.json() as Promise<T>;
}

/** Two deployment adapters, one job owner. Standalone development stays in process. */
export async function startWebVideoJob(input: VideoDownloadInput): Promise<StartJobResult> {
  if (process.env.STASH_CONTROL_PORT && process.env.STASH_CONTROL_TOKEN) {
    return workerRequest<StartJobResult>("/video-jobs", input);
  }
  return getRuntime().videoDownload.start(input);
}

export async function getWebVideoJob(id: string): Promise<VideoJobSnapshot | undefined> {
  if (process.env.STASH_CONTROL_PORT && process.env.STASH_CONTROL_TOKEN) {
    return (await workerRequest<VideoJobSnapshot | null>(`/video-jobs/${encodeURIComponent(id)}`)) ?? undefined;
  }
  return getRuntime().videoDownload.get(id);
}
