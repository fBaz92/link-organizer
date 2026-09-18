import { redirect } from "next/navigation";
import { Archive } from "lucide-react";
import { authEnabled, isAuthenticated } from "@/lib/auth";
import { LoginForm } from "@/components/login-form";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

/*
 * Flow: pagina di login, fuori dal route group protetto. Se l'auth non è
 * configurata (o la sessione è già valida) si viene rimandati all'archivio.
 */
export const dynamic = "force-dynamic";

export default async function LoginPage() {
  if (!authEnabled() || (await isAuthenticated())) redirect("/");

  return (
    <div className="flex min-h-dvh items-center justify-center px-4">
      <Card className="w-full max-w-sm">
        <CardHeader className="text-center">
          <div className="mx-auto mb-2 flex size-12 items-center justify-center rounded-xl bg-primary/10">
            <Archive className="size-6 text-primary" />
          </div>
          <CardTitle className="text-xl">Stash</CardTitle>
          <CardDescription>Il tuo archivio personale. Inserisci la password per entrare.</CardDescription>
        </CardHeader>
        <CardContent>
          <LoginForm />
        </CardContent>
      </Card>
    </div>
  );
}
