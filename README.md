# Stash (link-organizer)

Il tuo archivio personale di link, video, articoli, paper e documenti — con un bot Telegram come punto d'accesso e una pagina web per rileggerlo.

```
Telegram (dump) ──┐
Web (lettura) ────┼──► IngestionService ──► SQLite (FTS5) ──► cartella dati
Import CLI ───────┘      (dedup + tag)
```

Il repository è un **servizio [HomeGate](https://github.com/fBaz92/homegate)** (standard `service-standard.md`, ≥ 0.6.0): può essere selezionato da GitHub, analizzato, configurato e installato dal wizard **Servizi → Aggiungi servizio** e aggiornato con le release successive. Ogni evento del servizio è un log JSON su una riga, senza segreti.

- **Servizio installato da HomeGate**: bot Telegram completo (dump, ricerca, download video) + **visualizzatore web minimale** in sola lettura (ricerca, dettaglio, thumbnail, download file) servito dal processo stesso sulla porta `PORT`.
- **Sviluppo locale** (fuori da HomeGate): tutto resta come prima — web UI Next completa, bot, script CLI — con `pnpm dev`.

## Cosa fa il servizio

Raccoglie link e documenti che invii al bot Telegram, li classifica con tag automatici (regole keyword), li arricchisce con i metadati (YouTube via yt-dlp/oEmbed) e li archivia deduplicati in SQLite con ricerca full-text. Dal browser di casa puoi cercare e rileggere l'archivio; da Telegram puoi cercare, estrarre a sorte e scaricare i video che vengono rispediti in chat.

## Installazione con HomeGate (wizard)

Prerequisiti sul Raspberry:

1. **Node.js ≥ 22.13** già installato e visibile nel `PATH` (il wizard rifiuta runtime assenti o più vecchi; `node:sqlite` è integrato da 22.13). Il servizio non richiede `npm install`: tutto è nel bundle `dist/main.js` (~1,2 MB).
2. **yt-dlp** (e **ffmpeg** per la qualità 720p) se vuoi i download video: `sudo apt install yt-dlp ffmpeg` o equivalente. Senza yt-dlp i metadati cadono sull'oEmbed online e i download video non partono.

Procedura:

1. Dashboard → **Servizi → Aggiungi servizio**, collega GitHub con un token fine-grained (Contents/Metadata: Read-only) che includa questa repo.
2. Seleziona `fBaz92/link-organizer` e avvia l'analisi: servono il canale `stable`, il tag `vX.Y.Z`, `VERSION` e `service.toml` coerenti (vedi [Rilascio](#rilascio-di-una-nuova-versione)).
3. Compila i campi generati dal manifest:

   | Campo | Note |
   | --- | --- |
   | `BOT_TOKEN` | segreto, token di @BotFather |
   | `TELEGRAM_ALLOWED_USER_IDS` | il tuo ID Telegram (bot privato) |
   | `WEB_PASSWORD` | password del visualizzatore web |
   | `PORT` | porta HTTP (default 8787) |
   | `WEB_APP_URL` | facoltativo: indirizzo pubblico per i deep link (default stimato dalla LAN) |
   | `TELEGRAM_UPLOAD_CHAT_ID` | facoltativo: chat che riceve i video |
   | `YTDLP_PATH` | facoltativo: percorso di yt-dlp |

4. **Database**: puoi caricare uno snapshot SQLite esistente (`stash.db` con `user_version = 2` e tabelle `items`/`tags`/`items_tags`) oppure lasciare che il servizio crei il database al primo avvio. Il tuo `data/stash.db` attuale è già nel formato giusto: copialo tale e quale.
5. Scegli nome e URL (es. `http://<ip-raspberry>:8787/`) e installa.

HomeGate crea l'account dedicato, l'unità `homegate-app-<id>.service` e i percorsi persistenti. Codice in `releases/<versione>-<commit>` (sola lettura), configurazione `.env` in `/etc/homegate/services/link-organizer/`, dati scrivibili in `/var/lib/homegate/services/link-organizer/` (database, file, thumbnail: mai dentro la release). `.env` e database sopravvivono agli aggiornamenti.

### Percorsi e separazione codice/config/dati

| Cosa | Dove |
| --- | --- |
| Pacchetto (immutable) | `/opt/homegate/services/link-organizer/current/` → `dist/main.js`, `VERSION`, `service.toml` |
| Configurazione `.env` | `/etc/homegate/services/link-organizer/.env` (`HOMEGATE_CONFIG_DIR`) |
| Dati (SQLite + file) | `/var/lib/homegate/services/link-organizer/` (`HOMEGATE_STATE_DIR`) |

Il servizio individua tutto tramite le variabili `HOMEGATE_*` iniettate dall'unità: nessun dato viene scritto nella release (verificato dal test del pacchetto).

### Arresto, riavvio e log

Il processo resta in foreground, gestisce `SIGTERM` con arresto ordinato (bot → web → checkpoint WAL → chiusura DB → exit 0; uscita forzata di sicurezza dopo 20 s). Arresto/avvio dalla pagina del servizio; la pausa/ripresa è disponibile per i cgroup v2. Ogni evento è un oggetto JSON completo su una riga (`event`, `summary`, campi extra; i segreti sono oscurati), es.:

```json
{"ts":"2026-10-08T13:12:30.883Z","level":"info","event":"web_listening","summary":"Visualizzatore web in ascolto","port":8787,"bind":"0.0.0.0","auth":true}
```

## Aggiornamento

1. Su un commit pulito: aggiorna `VERSION`, eventualmente `service.toml`, ricompila il bundle (`pnpm build:service`) e committa (il CI rifiuta bundle non aggiornati).
2. Pubblica tag e canale stable (vedi [Rilascio](#rilascio-di-una-nuova-versione)).
3. Dashboard → Servizi → cerca aggiornamenti → installa, oppure `sudo homegate service-update link-organizer`.

HomeGate verifica contratto e runtime, prepara lo staging, attiva `current`, riavvia l'unità e la osserva per due secondi; in caso di fallimento ripristina la release precedente e blocca il commit (riprova con `--retry` dopo aver corretto). Le sezioni `release`, `environment` e `databases` del manifest devono restare identiche fra release: cambiarle richiede migrazione manuale del contratto locale; gli aggiornamenti gestiti accettano solo versioni superiori con lo stesso numero principale.

### Compatibilità dati e rollback

- Lo schema è `user_version = 2` (tabelle `items`, `tags`, `items_tags`, indice FTS5 con trigger) e **non cambia** fra 1.x: ogni release lascia i dati leggibili dalla precedente.
- Il servizio usa `node:sqlite` (integrato in Node) con la stessa interfaccia e lo stesso file di better-sqlite3: i test verificano l'interoperabilità nei due sensi (`src/db/node-sqlite-driver.test.ts`).
- Il rollback di HomeGate ripristina codice e `current`, **non** i dati: essendo lo schema invariato, la versione precedente continua a leggere il database così com'è. Per prudenza, prima di un aggiornamento fai un backup: dashboard → gestione del servizio, oppure copia consistente a servizio fermo (`sqlite3 stash.db ".backup backup.db"`).
- `sudo homegate services-recover` recupera solo i collegamenti di transazioni interrotte (a unità ferma); non è un comando di migrazione.

## Rilascio di una nuova versione

```bash
# dopo aver committato VERSION + dist/main.js aggiornati:
bash scripts/release.sh            # verifica tutto e stampa i comandi
bash scripts/release.sh 1.0.1 --yes # tagga v1.0.1 e aggiorna stable
```

In alternativa, dalla GitHub Action **verify** → *Run workflow* con la versione. Il contratto richiede: `VERSION` con `X.Y.Z` senza `v`, tag immutabile `vX.Y.Z` sul commit della release, ref `stable` promovuto allo stesso commit, `dist/main.js` tracciato nel commit (HomeGate usa `git archive` ≤ 20 MiB, non gli asset delle GitHub Release). Una correzione richiede versione e tag nuovi.

## Configurazione

Vedi `.env.example` per tutti i campi con commenti. Il manifest `service.toml` è la specifica usata dal wizard (campi, tipi, default, vincoli) e dichiara il database `stash.db` (`required = false`: senza upload viene creato al primo avvio). `DATA_DIR` è riservato allo sviluppo locale: sotto HomeGate vince `HOMEGATE_STATE_DIR`.

## Sviluppo locale (senza HomeGate)

```bash
pnpm install
cp .env.example .env   # BOT_TOKEN, TELEGRAM_ALLOWED_USER_IDS, WEB_PASSWORD…
pnpm db:migrate        # crea data/stash.db (idempotente)
pnpm dev               # web UI Next (3002) + servizio (bot + visualizzatore su 8787)
```

La web UI completa (filtri, note, wizard download con avanzamento) gira con `next dev`/`next start` e usa better-sqlite3; il servizio (`src/service/main.ts`, eseguibile anche con `pnpm start:service`) usa node:sqlite. I due processi condividono lo stesso database in WAL senza conflitti.

Script CLI (solo sviluppo, richiedono le dipendenze): `pnpm import:telegram`, `pnpm enrich`, `pnpm auto-tag` (tag semantici con modello locale — non incluso nel servizio HomeGate), `pnpm seed:demo`.

### Comandi del bot

| Comando | Cosa fa |
| --- | --- |
| `/cerca <testo>` | Ricerca full-text; filtri con `#tag` e `tipo:video` |
| `/scarica [link]` | Scarica un video YouTube e lo invia in chat; senza link apre il wizard (ultimi 20 o parola chiave) |
| `/recenti` | Ultimi item archiviati |
| `/lucky [#tag]` | 10 estrazioni a caso tra i non visti |
| `/tag`, `/stat` | Tag più usati, statistiche |
| `/aiuto` | Guida nel bot |

C'è anche l'**inline mode**: `@nomebot <query>` in qualunque chat.

## Test

```bash
pnpm test            # 142 test: dominio, bot, DB (inclusi i due driver SQLite), web UI, contratto
pnpm test:package    # prova del pacchetto estratto: avvio, HTTP, SIGTERM→exit 0, release intatta
pnpm typecheck
pnpm build           # web UI Next
pnpm build:service   # bundle dist/main.js
```

## Limiti noti del pacchetto HomeGate

- La **web UI Next completa non entra nel pacchetto**: il contratto limita l'archivio a 20 MiB e vieta build/installazioni sul dispositivo; la webapp porta node_modules e un modulo nativo (better-sqlite3). Il servizio include quindi un **visualizzatore read-only**; per l'editing completo usa il bot o la webapp in sviluppo locale (stesso database).
- I **tag semantici** (transformers.js, ~120 MB) restano uno script di sviluppo: `pnpm auto-tag` sullo stesso database.
- Architetture dichiarate: `arm64` e `amd64` (il bundle è JavaScript puro); `armv7` non dichiarato perché non provato.
- Il download video richiede yt-dlp/ffmpeg provisionati dall'operatore.
