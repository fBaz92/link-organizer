import { Download } from "lucide-react";
import { latestArchiveVideosAction } from "@/app/actions";
import { DownloadWizard } from "@/components/download-wizard";

/*
 * Flow: pagina "Scarica video". Server component sottile: carica gli ultimi
 * 20 video YouTube dell'archivio (via la stessa action del wizard, così la
 * forma dei dati è definita in un posto solo) e delega tutto l'interattivo
 * al client component DownloadWizard.
 */
export default async function ScaricaPage() {
  const recent = await latestArchiveVideosAction();

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <h1 className="flex items-center gap-2 text-xl font-bold">
          <Download className="size-5 text-primary" aria-hidden />
          Scarica video
        </h1>
        <p className="text-sm text-muted-foreground">
          Da YouTube all&apos;archivio e alla tua chat Telegram, in un colpo solo.
        </p>
      </div>
      <DownloadWizard recent={recent} />
    </div>
  );
}
