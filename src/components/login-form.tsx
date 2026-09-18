"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { loginAction, type ActionResult } from "@/app/actions";

/*
 * Flow: form di login (client). useActionState mostra l'errore; in caso di
 * successo la server action imposta il cookie e reindirizza all'archivio.
 */
export function LoginForm() {
  const [state, formAction, pending] = useActionState<ActionResult | null, FormData>(loginAction, null);

  return (
    <form action={formAction} className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="password">Password</Label>
        <Input
          id="password"
          name="password"
          type="password"
          required
          autoFocus
          autoComplete="current-password"
        />
      </div>
      {state && !state.ok && <p className="text-sm text-destructive">{state.message}</p>}
      <Button type="submit" className="w-full cursor-pointer" disabled={pending}>
        {pending ? "Accesso…" : "Entra"}
      </Button>
    </form>
  );
}
