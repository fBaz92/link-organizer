# Stash (link-organizer)

Il tuo archivio personale di link, video, articoli, paper e documenti — con un bot Telegram come punto d'accesso e una webapp completa per rileggerlo.

```
Telegram (dump) ──┐
Web UI (lettura) ─┼──► IngestionService ──► SQLite (FTS5) ──► /data
Import CLI ───────┘      (dedup + tag)
```

Il repository è un **servizio [HomeGate](https://github.com/fBaz92/homegate)** con **profilo Docker** (HomeGate ≥ 0.8.0, Docker Engine ≥ 28 sul gateway): dal wizard **Servizi → Aggiungi servizio** si seleziona la repo, si configura e si installa; gli aggiornamenti arrivano dalle release successive. Il container ospita la **webapp Next completa** e il **bot Telegram** in un unico processo supervisory.

- **Dentro il container**: webapp completa (ricerca, filtri, note, wizard download video), bot Telegram, yt-dlp e ffmpeg già inclusi.
- **Sviluppo locale** (fuori da HomeGate): tutto come prima — `pnpm dev` avvia webapp Next e bot sullo stesso database.

## Cosa fa il servizio

Raccoglie link e documenti che invii al bot Telegram, li classifica con tag automatici, li arricchisce con i metadati (YouTube via yt-dlp) e li archivia deduplicati in SQLite con ricerca full-text. Dal browser di casa cerchi, annoti e scarichi l'archivio; da Telegram cerchi, estrai a sorte e ricevi i video scaricati.

**Thumbnail sempre al passo**: all'avvio e poi ogni 6 ore il servizio cerca gli item rimasti senza thumbnail (import vecchi, arricchimenti falliti) e le scarica — per YouTube direttamente dall'URL pubblico, per gli altri siti dai metadati della pagina. In locale la stessa cosa: `pnpm thumbs`.

## Installazione con HomeGate (profilo Docker)

Prerequisiti sul gateway (Raspberry):

1. **HomeGate ≥ 0.8.0** e **Docker Engine ≥ 28** funzionante (l'analisi blocca l'installazione senza Docker).
2. Nient'altro: Node, ffmpeg e yt-dlp sono già nell'immagine.

Procedura:

1. Dashboard → **Servizi → Aggiungi servizio**, collega GitHub con un token fine-grained (Contents/Metadata: Read-only) che includa questa repo.
2. Seleziona `fBaz92/link-organizer` e avvia l'analisi: servono il canale `stable`, il tag `vX.Y.Z`, `VERSION` e `service.toml` con l'immagine pinata a digest (vedi [Rilascio](#rilascio-di-una-nuova-versione)).
3. Compila i campi generati dal manifest:

   | Campo | Note |
   | --- | --- |
   | `HOMEGATE_IDLE_MINUTES` | minuti di inattività prima del riposo (vedi sotto) |
   | `BOT_TOKEN` | segreto, token di @BotFather |
   | `TELEGRAM_ALLOWED_USER_IDS` | il tuo ID Telegram (bot privato) |
   | `WEB_PASSWORD` | password della webapp |
   | `WEB_APP_URL` | facoltativo: URL pubblico per i deep link (es. `http://IP-GATEWAY:8790`) |
   | `TELEGRAM_UPLOAD_CHAT_ID` | facoltativo: chat che riceve i video |
   | `YTDLP_PATH` | facoltativo: override di yt-dlp (già incluso) |

4. **Database**: puoi caricare uno snapshot SQLite esistente (`stash.db`, `user_version = 2`) oppure lasciare che venga creato al primo avvio. Il file `data/stash.db` di versioni precedenti (1.x o sviluppo locale) è già nel formato giusto.
5. Scegli nome e URL e installa. L'URL pubblico è `http://<ip-gateway>:8790` (il proxy HomeGate; la porta del container non è esposta in LAN).

### Riposo, risveglio e bot

Dopo `HOMEGATE_IDLE_MINUTES` senza richieste il **container si ferma** (default del manifest: 1440 minuti = 24 h); al primo accesso riparte e la pagina di attesa mostra l'app quando `/health` risponde. Conseguenze e mitigazioni:

- **Durante il riposo anche il bot Telegram è fermo**: nessun dump finché qualcuno non apre la webapp. Tieni il timeout alto, oppure lascia una scheda della webapp aperta (una connessione SSE `/api/keepalive` tiene sveglio il container finché la scheda è visibile — pensato anche per un tablet a muro).
- **Avvia/Arresta/Riprendi** dalla pagina del servizio; un aggiornamento richiede prima di avviare o riprendere un container fermo.

### Com'è fatto il container

- Un solo container (niente compose): `docker/entrypoint.mjs` fa da supervisor PID-1 e avvia la **webapp Next standalone** (processo primario, readiness `/health`) e il **bot** (worker secondario: se il token è errato la webapp resta su e l'errore è nei log).
- Filesystem in sola lettura tranne `/data` (dati persistenti: SQLite, file, thumbnail), `/tmp` e `/run`; la cache di Next vive su `/tmp`. UID/GID non root assegnati da HomeGate.
- SIGTERM gestito entro 10 secondi (checkpoint del WAL incluso); ogni evento è un oggetto JSON su una riga, senza segreti.
- Il proxy HomeGate accetta body fino a **16 MiB** per richiesta: per file più grandi usa il bot Telegram (fino a 20 MB) o l'import locale. Le connessioni SSE tengono sveglio il servizio; timeout di lettura 30 s (keepalive a 15 s).

## Aggiornamenti

1. Si pubblica una nuova release (vedi sotto): il workflow costruisce l'immagine multiarch, la carica su GHCR, pinna il **digest** in `service.toml`, aggiorna `VERSION` e crea tag + `stable`.
2. Dalla pagina del servizio: **Cerca aggiornamenti** → installa. HomeGate scarica la nuova immagine prima di sostituire quella attiva, verifica la readiness e in caso di errore ripristina la release precedente.
3. Tra release possono cambiare digest dell'immagine e descrizione; porte, limiti, readiness, contratto `release`, campi `environment` e `databases` devono restare invariati.

### Compatibilità dati e rollback

- Lo schema resta `user_version = 2` (stesse tabelle e FTS5): ogni release lascia i dati leggibili dalla precedente, dentro e fuori dal container (i test verificano l'interoperabilità fra i due driver SQLite).
- Il rollback ripristina codice e immagine, **non** tocca i dati in `/data`. Per prudenza fai un backup prima degli aggiornamenti (pagina del servizio o copia consistente a container fermo).
- **Migrazione da 1.x (runtime node)**: il contratto cambia runtime, quindi serve rimozione e reinstallazione dal wizard con la 2.x. I dati si riportano caricando `stash.db` come snapshot durante il setup.

## Rilascio di una nuova versione

```bash
# 1) aggiorna VERSION (X.Y.Z) e committa (il bundle del bot va ricompilato se src/service è cambiato: pnpm build:service)
# 2) dalla GitHub Action "docker-release" → Run workflow con la versione
```

Il workflow: test → build immagine `linux/arm64`+`linux/amd64` → push su `ghcr.io/fbaz92/link-organizer` (tag `vX.Y.Z` e `stable` per comodità; il manifest usa solo il **digest immutabile**) → prova del container (`scripts/docker-check.sh`) → commit del digest in `service.toml` → tag `vX.Y.Z` e canale `stable` sullo stesso commit.

> Dopo il primissimo push, il pacchetto GHCR nasce privato: rendilo pubblico (Impostazioni del pacchetto) oppure predisponi `sudo docker login` di sola lettura sul gateway — il token GitHub del wizard non autorizza registry privati.

## Configurazione

Vedi `.env.example`. Il manifest `service.toml` è la specifica del wizard e dichiara il database `stash.db` (facoltativo: creato al primo avvio). Nel container l'`.env` è iniettato nell'ambiente e montato in sola lettura in `/config/.env`; i dati vivono in `/data`.

## Sviluppo locale (senza HomeGate)

```bash
pnpm install
cp .env.example .env   # BOT_TOKEN, TELEGRAM_ALLOWED_USER_IDS, WEB_PASSWORD…
pnpm db:migrate        # crea data/stash.db (idempotente)
pnpm dev               # webapp Next (3002) + servizio bot+visualizzatore (8787)
```

La webapp gira con better-sqlite3; il processo bot usa node:sqlite: stesso database in WAL, zero conflitti. Immagine Docker locale: `docker build -t stash .` e prova con `bash scripts/docker-check.sh`.

Script CLI (solo sviluppo): `pnpm import:telegram`, `pnpm enrich`, `pnpm thumbs` (backfill thumbnail), `pnpm auto-tag` (tag semantici con modello locale), `pnpm seed:demo`.

### Comandi del bot

| Comando | Cosa fa |
| --- | --- |
| `/cerca <testo>` | Ricerca full-text; filtri con `#tag` e `tipo:video` |
| `/scarica [link]` | Scarica un video YouTube e lo invia in chat; senza link apre il wizard (ultimi 20 o parola chiave) |
| `/recenti` | Ultimi item archiviati |
| `/lucky [#tag]` | 10 estrazioni a caso tra i non visti |
| `/tag`, `/stat` | Tag più usati, statistiche |
| `/aiuto` | Guida nel bot |

## Test

```bash
pnpm test            # suite: dominio, bot, DB (due driver SQLite), backfill, contratto Docker
pnpm test:package    # bundle bot estratto: avvio, HTTP, SIGTERM→exit 0
bash scripts/docker-check.sh   # container: build, /health, auth, RO fs, UID non root, SIGTERM
pnpm typecheck && pnpm build   # webapp standalone
```

## Limiti noti

- Durante il **riposo del container** il bot Telegram è fermo (mitigato da `HOMEGATE_IDLE_MINUTES` alto e dal keepalive a scheda aperta): è il modello del profilo Docker di HomeGate, non un difetto configurabile lato app.
- Upload via web limitati a **16 MiB** per richiesta (proxy HomeGate): oltre, usa il bot.
- I tag semantici restano uno script di sviluppo (`pnpm auto-tag`): il modello locale non entra nel container.
