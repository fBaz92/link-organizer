"use client";

import { useEffect } from "react";

/*
 * Flow: tiene aperta una connessione SSE verso /api/keepalive finché la
 * webapp è in una scheda visibile. Nel profilo Docker di HomeGate le
 * connessioni in corso impediscono il riposo del container: così il bot
 * Telegram resta attivo mentre qualcuno sta usando l'archivio. EventSource
 * si riconnette da solo; alla chiusura della scheda la connessione cade.
 */
export function KeepAlive() {
  useEffect(() => {
    const source = new EventSource("/api/keepalive");
    return () => source.close();
  }, []);

  return null;
}
