import { isAuthenticated } from "@/lib/auth";
import { getWebVideoJob } from "@/core/web-video-jobs";

/*
 * Flow: stato di un job di download video, per il polling del wizard.
 * Route autenticata: nel container i job appartengono al worker sempre
 * attivo, quindi lo stato resta disponibile dopo il riposo della webapp.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  if (!(await isAuthenticated())) return new Response("Non autorizzato", { status: 401 });

  const { id } = await params;
  const job = await getWebVideoJob(id);
  if (!job) return new Response("Job non trovato", { status: 404 });

  return Response.json(job, { headers: { "cache-control": "private, no-store" } });
}
