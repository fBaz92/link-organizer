"use client";

import { useTransition } from "react";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Trash2 } from "lucide-react";
import { deleteItemAction } from "@/app/actions";

/*
 * Flow: eliminazione con conferma esplicita (dialog): l'azione parte solo
 * dopo il click positivo; la server action reindirizza all'archivio.
 */
export function DeleteButton({ itemId }: { itemId: number }) {
  const [pending, startTransition] = useTransition();

  return (
    <Dialog>
      <DialogTrigger
        render={
          <Button variant="outline" size="sm" className="cursor-pointer text-destructive hover:text-destructive">
            <Trash2 className="size-4" />
            Elimina
          </Button>
        }
      />
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Eliminare questo item?</DialogTitle>
          <DialogDescription>
            L&apos;operazione non è reversibile: item, tag e file associato verranno rimossi.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose render={<Button variant="outline" className="cursor-pointer" />}>
            Annulla
          </DialogClose>
          <Button
            variant="destructive"
            disabled={pending}
            className="cursor-pointer"
            onClick={() => startTransition(() => deleteItemAction(itemId))}
          >
            {pending ? "Eliminazione…" : "Elimina"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
