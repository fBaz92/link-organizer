import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "@/lib/utils";

/*
 * Flow: rendering del markdown per le superfici documentali di Stash
 * (note personali, descrizioni, pagina aiuto). Il wrapper `typeset
 * typeset-docs` applica lo stylesheet shadcn/typeset: dentro vengono
 * stilizzati titoli, liste, tabelle, codice e citazioni senza classi sul
 * contenuto; fuori dal wrapper nulla cambia.
 */
export function MarkdownView({ content, className }: { content: string; className?: string }) {
  return (
    <div className={cn("typeset typeset-docs max-w-[37em]", className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
    </div>
  );
}
