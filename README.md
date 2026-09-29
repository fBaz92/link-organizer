# Stash

Il tuo archivio personale di link, video, articoli, paper e documenti — con un bot Telegram come punto d'accesso e una web UI moderna per rileggerlo.

```
Telegram (dump) ──┐
Web UI (lettura) ─┼──► IngestionService ──► SQLite (FTS5) ──► data/
Import CLI ───────┘      (dedup + tag)
```

## Setup in 5 minuti

**1. Dipendenze**

```bash
pnpm install
```

**2. Il bot**: su Telegram apri [@BotFather](https://t.me/BotFather) → `/newbot` → copia il token.

**3. Il tuo user ID**: scrivi a [@userinfobot](https://t.me/userinfobot) → ti risponde con il tuo ID numerico.

**4. Configurazione**

```bash
cp .env.example .env
# poi compila .env con:
#   BOT_TOKEN=123456:ABC…            (token di BotFather)
#   TELEGRAM_ALLOWED_USER_IDS=12345  (il tuo ID: il bot è privato)
#   WEB_PASSWORD=una-bella-password  (accesso alla web UI)
#   WEB_APP_URL=http://192.168.1.10:3000  (per i deep link del bot, se accedi da LAN)
```

**5. Database e avvio**

```bash
pnpm db:migrate   # crea data/stash.db (le migrazioni sono idempotenti)
pnpm dev          # web (next dev) + bot (long polling) insieme
```

Apri `http://localhost:3000`, entra con la password, e manda il primo link al bot: vedrai conferma immediata con i tag assegnati, poi titolo e thumbnail arrivano in pochi secondi.

## Comandi del bot

| Comando | Cosa fa |
| --- | --- |
| `/cerca <testo>` | Ricerca full-text; filtri con `#tag` e `tipo:video` |
| `/scarica [link]` | Scarica un video YouTube e lo invia in chat; senza link apre il wizard (ultimi 20 o parola chiave) |
| `/recenti` | Ultimi item archiviati |
| `/lucky [#tag]` | 10 estrazioni a caso tra i non visti |
| `/tag`, `/stat` | Tag più usati, statistiche |
| `/aiuto` | Guida nel bot |

C'è anche l'**inline mode**: in qualunque chat scrivi `@nomebot <query>`.

In `/cerca` ogni risultato si può aprire o **eliminare** (con conferma).

## Download dei video YouTube

Stessa funzione su Telegram e web UI, stesso motore (`src/core/video-download.ts`):

- **Diretto**: `/scarica https://youtu.be/…` nel bot, oppure il campo link nella pagina **Scarica video** (`/scarica`) della web UI. Il video viene archiviato (se è nuovo), scaricato e **inviato sulla chat Telegram**.
- **Wizard**: `/scarica` senza argomenti o la pagina `/scarica` della web UI. Si sceglie tra gli **ultimi 20 video archiviati** oppure si scrive una **parola chiave**: la ricerca è "simile" (tolleranza a refusi via Levenshtein, prefissi, diacritici; pesa titolo, canale e tag — vedi `src/core/similarity.ts`), limitata ai **primi 30 risultati** con titolo e canale.

Serve **yt-dlp** sul server (`brew install yt-dlp`; anche **ffmpeg** per la qualità 720p). I video oltre il limite di invio dei bot (~50 MB) vengono **spezzettati in parti con ffmpeg** (senza ricodifica, split sui keyframe: veloce e senza perdita di qualità) e inviati in sequenza come «parte 1/N, 2/N…»; il file intero resta nell'archivio, agganciato al suo item (**Scarica file** dal dettaglio). Tetto difensivo: 2 GB per video. Dalla web UI il video arriva sulla chat di `TELEGRAM_UPLOAD_CHAT_ID` (default: il primo ID autorizzato).

## Web UI

- **Archivio** — filtri per tipo/tag/**canale**/stato, ricerca full-text (FTS5), paginazione.
- **Dettaglio item** — flag *visto* ✓ e *preferito* ⭐, tag editabili, **note in markdown**, download del file, canale cliccabile ("vedi tutti i suoi item") e azione *Recupera dettagli*.
- **Scarica video** — wizard link / ultimi 20 / parola chiave, con avanzamento live del download.
- **Mi sento fortunato** — 10 estrazioni tra i non visti, filtri per tag/tipo, *Rimischia*.
- **Tag** e **Aiuto**.

I **video** mostrano l'anteprima subito: appena archiviato usano la thumbnail pubblica di YouTube, poi viene sostituita dalla copia locale scaricata con i metadati (titolo, descrizione, **canale** — presi via oEmbed, senza API key). Il canale è filtrabile dalla barra filtri e cliccabile da card e dettaglio.

Il tema segue il sistema (con toggle); l'interfaccia è in italiano.

## Import del tuo storico

Hai anni di link in "Saved Messages"? Da Telegram **Desktop**: *Impostazioni → Avanzate → Esporta dati di Telegram → Esporta solo la chat* (le "Saved messages"). Poi:

```bash
pnpm import:telegram ~/Downloads/TelegramExport          # veloce, senza fetch dei metadati
pnpm import:telegram ~/Downloads/TelegramExport --meta   # arricchisce anche titoli e thumbnail
```

La pipeline è la stessa del bot: i link già presenti vengono riconosciuti come duplicati e saltati.

## Architettura (per metterci le mani)

```
src/
├── core/               # dominio puro, condiviso da web/bot/import
│   ├── url.ts          # normalizzazione "furbo" + sha256 (dedup URL)
│   ├── classify.ts     # classificatore regex: dominio/path/titolo → tipo + tag
│   ├── rules/tag-rules.ts  # LE REGOLE EDITABILI dei tag
│   ├── ingestion.ts    # pipeline unica (dedup → classificazione → persistenza)
│   ├── metadata.ts     # oEmbed/OpenGraph con guardia SSRF a ogni redirect
│   ├── similarity.ts   # ricerca "simile" (Levenshtein + prefissi + pesi campo)
│   ├── video-download.ts   # job yt-dlp → store → upload Telegram
│   ├── security/url-guard.ts  # http/https only, blocco host privati/riservati
│   └── files.ts        # store dei file, dedup per hash del contenuto
├── db/                 # Drizzle + better-sqlite3 (WAL), FTS5 con trigger
├── bot/                # worker grammY (processo separato, long polling)
├── app/                # web UI (App Router, server components, server actions)
└── scripts/            # import CLI
```

Note di design:

- **Dedup**: URL normalizzati (via tracking, YouTube → `youtu.be/<id>`, Spotify, X) e hashati; i file sono hashati per contenuto. Due processi (web + bot) condividono lo stesso SQLite in WAL senza conflitti.
- **Tag**: le regole sono dati, non codice — aggiungerne una è una riga in `tag-rules.ts`. Il titolo arricchisce, non decide.
- **Sicurezza**: allowlist Telegram, password con sessione HMAC a 30 giorni, file/thumbnail serviti solo da route autenticate, SSRF guard su ogni richiesta di rete (inclusi i redirect).
- **Test**: `pnpm test` (Vitest, 50 test: normalizzazione, dedup, classificazione, pipeline su DB in-memory, guardia SSRF, handler bot con API finta).

```bash
pnpm test        # suite
pnpm typecheck   # tsc --noEmit
pnpm build       # build di produzione della web UI
```

## Produzione (bare node)

```bash
pnpm build
pnpm start       # next start + bot worker (concurrently)
```

Per far girare il bot 24/7: `pm2 start "pnpm start" --name stash` o un paio di unit systemd (`pnpm start:web`, `pnpm start:bot`).

## Per dopo

- Download da **altri siti video** (Vimeo, ecc.): il motore in `core/video-download.ts` è già parametrico sull'estrattore dell'ID — la pipeline resta, cambia solo la sorgente.
- **Playlist**: `/scarica` oggi scarica il singolo video (`--no-playlist`).
