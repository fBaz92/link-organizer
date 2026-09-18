import { readFileSync } from "node:fs";
import path from "node:path";
import { Archive } from "lucide-react";
import { MarkdownView } from "@/components/markdown-view";
import { logoutAction } from "@/app/actions";
import { authEnabled } from "@/lib/auth";
import { Button } from "@/components/ui/button";

/*
 * Flow: pagina Aiuto. Il markdown della guida viene letto UNA volta a
 * modulo caricato (I/O statico hoistato) e renderizzato con il wrapper
 * typeset — è una delle superfici documentali dell'app.
 * Nota: in produzione il file va insieme ai sorgenti (requisito di Stash:
 * deploy bare-node dal repo).
 */
const GUIDE_PATH = path.join(process.cwd(), "src", "content", "aiuto.md");
const GUIDE = readFileSync(GUIDE_PATH, "utf8");

export default function AiutoPage() {
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="flex items-center gap-2 text-xl font-bold">
          <Archive className="size-5 text-primary" />
          Aiuto
        </h1>
        {authEnabled() && (
          <form action={logoutAction}>
            <Button variant="outline" size="sm" className="cursor-pointer md:hidden">
              Esci
            </Button>
          </form>
        )}
      </div>
      <MarkdownView content={GUIDE} className="rounded-xl border bg-card p-6" />
    </div>
  );
}
