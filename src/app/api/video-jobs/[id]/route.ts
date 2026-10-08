import { isAuthenticated } from "@/lib/auth";
import { getRuntime } from "@/core/get-runtime";

/*
 * Flow: stato di un job di download video, per il polling del wizard.
 * Route autenticata come le altre della web UI; il job vive nel processo
 * (memoizzato nel runtime) quindi azione server e polling condividono la
 * stessa registry finché la web app gira.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  if (!(await isAuthenticated())) return new Response("Non autorizzato", { status: 401 });

  const { id } = await params;
  const job = getRuntime().videoDownload.get(id);
  if (!job) return new Response("Job non trovato", { status: 404 });

  return Response.json(job, { headers: { "cache-control": "private, no-store" } });
}
