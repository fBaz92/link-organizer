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
| `/recenti` | Ultimi item archiviati |
| `/lucky [#tag]` | 10 estrazioni a caso tra i non visti |
| `/tag`, `/stat` | Tag più usati, statistiche |
| `/aiuto` | Guida nel bot |

C'è anche l'**inline mode**: in qualunque chat scrivi `@nomebot <query>`.

In `/cerca` ogni risultato si può aprire o **eliminare** (con conferma).

## Web UI

- **Archivio** — filtri per tipo/tag/**canale**/stato, ricerca full-text (FTS5), paginazione.
- **Dettaglio item** — flag *visto* ✓ e *preferito* ⭐, tag editabili, **note in markdown**, download del file, canale cliccabile ("vedi tutti i suoi item") e azione *Recupera dettagli*.
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

Il **download dei video** (yt-dlp è già sul tuo server): l'architettura lo accoglie come `VideoFetcher` nel dominio, agganciato all'item di tipo `video`.
