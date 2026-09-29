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
- **Scarica video** (`/scarica`): incolla un link YouTube, o scegli tra gli ultimi 20 video archiviati, o cerca per parola chiave — il video viene scaricato e inviato sulla tua chat Telegram.
- I **video** mostrano l'anteprima subito (finché non arriva la copia locale, usano la thumbnail YouTube) e il **canale** cliccabile: un click e vedi tutti i suoi item salvati.
- In ogni item puoi segnare **visto/da vedere**, mettere **⭐ preferito**, modificare i **tag** e scrivere **note in markdown**. Se mancano titolo/anteprima, il bottone **Recupera dettagli** rifetcha i metadati.

## Il bot, oltre al dump

| Comando | Cosa fa |
| --- | --- |
| `/cerca <testo>` | Cerca nell'archivio; filtri con `#tag` e `tipo:video` |
| `/scarica [link]` | Scarica un video YouTube e lo manda in chat; senza link apre il wizard |
| `/recenti` | Ultimi item archiviati |
| `/lucky [#tag]` | 10 estrazioni a caso tra i non visti |
| `/tag` | I tag più usati |
| `/stat` | Statistiche dell'archivio |
| `/aiuto` | Questo messaggio |

Dai risultati di `/cerca` puoi **aprire** l'originale o **eliminarlo**. In qualunque chat puoi anche scrivere `@nomebot <query>` (inline mode).

## Il download dei video

Funziona su due binari, **Telegram e web UI**, con lo stesso motore:

- **Diretto**: `/scarica https://youtu.be/…` su Telegram, o il campo link in `/scarica` sulla web UI. Il video viene archiviato (se nuovo), scaricato e inviato in chat.
- **Wizard**: `/scarica` senza argomenti (o la pagina `/scarica` della web UI) fa scegliere tra gli **ultimi 20 video** archiviati oppure una **ricerca per parola chiave** — non è una parità di stringa: tollera refusi, prefissi e diacritici, e pesa titolo, canale e tag. Massimo **30 risultati** (titolo e canale).

Dettagli tecnici: il download usa **yt-dlp** (max 720p, con ffmpeg; `YTDLP_PATH` per un binario personalizzato). Oltre il limite di invio dei bot (~50 MB) il video viene **spezzettato in parti con ffmpeg** (senza ricodifica) e inviato come «parte 1/N, 2/N…»; il file intero resta nell'archivio, agganciato al suo item — da dove puoi riscaricarlo con **Scarica file**. Se invii dalla web UI, il video arriva sulla chat impostata in `TELEGRAM_UPLOAD_CHAT_ID` (default: il tuo user ID autorizzato).

## Come vengono assegnati i tag

Le regole vivono in `src/core/rules/tag-rules.ts`: pattern regex su dominio, path e titolo (YouTube → `video`, arXiv → `paper`, GitHub → `repo`, e via). Puoi aggiungerne liberamente: basta una nuova riga. Il titolo può solo **arricchire** (es. `#guide`, `#talk`), non cambiare tipo.

## Dedup: come funziona

Prima di archiviare, Stash normalizza l'URL (via ai parametri di tracking, `youtube.com/watch?v=…` e `youtu.be/…` diventano la stessa identità) e ne calcola un hash. Per i file conta l'hash del **contenuto**: lo stesso PDF mandato due volte, anche con nomi diversi, è un solo item.

## Sicurezza

- Il bot risponde **solo** agli user ID in `TELEGRAM_ALLOWED_USER_IDS`.
- La web UI è protetta da password (`WEB_PASSWORD`) con sessione firmata a 30 giorni.
- Il download dei metadati blocca gli indirizzi di rete interni (niente SSRF).

## Per dopo

Il download da **altri siti video** oltre YouTube: il motore è pronto, va solo insegnata l'estrazione dell'ID per la nuova sorgente.
