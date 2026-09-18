# Benvenuto in Stash

**Stash** è il tuo archivio personale: mandi link, video, articoli e file, e restano tuoi — classificati, cercabili e deduplicati.

## Come si usa

### Da Telegram (il dump)
- Manda al bot un **link** o un **file**: viene archiviato subito, con tipo e tag assegnati dalle regole di classificazione.
- Se l'item esiste già, il bot te lo dice: niente duplicati, mai.
- I dettagli (titolo vero, descrizione, immagine) arrivano pochi secondi dopo, in background.

### Dal browser (la lettura)
- **Archivio** (`/`): filtra per tipo, tag, **canale** e stato; la ricerca è full-text (titoli, descrizioni e autori).
- **Mi sento fortunato** (`/lucky`): 10 estrazioni a caso tra i non visti, con filtri — per riscoprire quello che ti era scivolato via.
- **Tag** (`/tags`): panoramica di tutti i tag con conteggi.
- I **video** mostrano l'anteprima subito (finché non arriva la copia locale, usano la thumbnail YouTube) e il **canale** cliccabile: un click e vedi tutti i suoi item salvati.
- In ogni item puoi segnare **visto/da vedere**, mettere **⭐ preferito**, modificare i **tag** e scrivere **note in markdown**. Se mancano titolo/anteprima, il bottone **Recupera dettagli** rifetcha i metadati.

## Il bot, oltre al dump

| Comando | Cosa fa |
| --- | --- |
| `/cerca <testo>` | Cerca nell'archivio; filtri con `#tag` e `tipo:video` |
| `/recenti` | Ultimi item archiviati |
| `/lucky [#tag]` | 10 estrazioni a caso tra i non visti |
| `/tag` | I tag più usati |
| `/stat` | Statistiche dell'archivio |
| `/aiuto` | Questo messaggio |

Dai risultati di `/cerca` puoi **aprire** l'originale o **eliminarlo**. In qualunque chat puoi anche scrivere `@nomebot <query>` (inline mode).

## Come vengono assegnati i tag

Le regole vivono in `src/core/rules/tag-rules.ts`: pattern regex su dominio, path e titolo (YouTube → `video`, arXiv → `paper`, GitHub → `repo`, e via). Puoi aggiungerne liberamente: basta una nuova riga. Il titolo può solo **arricchire** (es. `#guide`, `#talk`), non cambiare tipo.

## Dedup: come funziona

Prima di archiviare, Stash normalizza l'URL (via ai parametri di tracking, `youtube.com/watch?v=…` e `youtu.be/…` diventano la stessa identità) e ne calcola un hash. Per i file conta l'hash del **contenuto**: lo stesso PDF mandato due volte, anche con nomi diversi, è un solo item.

## Sicurezza

- Il bot risponde **solo** agli user ID in `TELEGRAM_ALLOWED_USER_IDS`.
- La web UI è protetta da password (`WEB_PASSWORD`) con sessione firmata a 30 giorni.
- Il download dei metadati blocca gli indirizzi di rete interni (niente SSRF).

## Per dopo

Il download dei video (yt-dlp) è già previsto dall'architettura: l'interfaccia `VideoFetcher` nel dominio è pronta ad accoglierlo.
