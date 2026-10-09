# Stash (link-organizer)

Il tuo archivio personale di link, video, articoli, paper e documenti — con un bot Telegram come punto d'accesso e una webapp completa per rileggerlo.

```
Telegram (dump) ──┐
Web UI (lettura) ─┼──► IngestionService ──► SQLite (FTS5) ──► /data
Import CLI ───────┘      (dedup + tag)
```

Il progetto funziona anche senza HomeGate. Il repository include un **servizio [HomeGate](https://github.com/fBaz92/homegate)** con **profilo Docker** (HomeGate ≥ 0.8.0, Docker Engine ≥ 28 sul gateway): dal wizard **Servizi → Aggiungi servizio** si seleziona la repo, si configura e si installa; gli aggiornamenti arrivano dalle release successive. Un solo container ospita la **webapp Next completa**, il **bot Telegram** e un modulo HTTP leggero che gestisce il riposo della webapp.

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

Le specifiche HomeGate sono conservate in [docs/homegate](docs/homegate/README.md), con versione, provenienza e verifica del contratto.

### Riposo, risveglio e bot

Dalla versione 2.2.0 **Telegram resta attivo anche quando la webapp dorme**. Dopo 5 minuti senza richieste della webapp, il modulo di supervisione arresta Next e ne libera la memoria. Se `HOMEGATE_IDLE_MINUTES` è inferiore a 5, usa quella soglia. La prima richiesta successiva riavvia Next e viene inoltrata senza perdere metodo, corpo o upload. Le richieste simultanee condividono un solo avvio.

L'installazione resta unica, dalla stessa repo GitHub. In HomeGate una connessione SSE autenticata attraverso il proxy mantiene attivo il container, secondo il contratto sulle richieste in corso. La webapp può quindi riposare internamente. Non servono un secondo container, il socket Docker o l'opzione manuale "Sempre attivo". `/health` mostra stato del bot, stato della webapp e connessione al proxy, senza risvegliare Next.

Il modulo rileva automaticamente il proxy HomeGate tramite il gateway di rete del container e la porta pubblica 8790. In reti Docker personalizzate si può impostare `STASH_HOMEGATE_PROXY_URL`; se il collegamento non riesce, `/health` mostra `homegate.lease = "failed"` e i log indicano il problema. In quel caso il gateway può ancora arrestare tutto il container: correggere la rete oppure usare temporaneamente "Sempre attivo".

I download avviati dalla webapp appartengono allo stesso worker che gestisce Telegram. Chiudere il browser e lasciare dormire Next non interrompe il video; il job resta consultabile al risveglio. Il bot salva link e gestisce i comandi direttamente, senza dover avviare Next.

**Arresto manuale e pausa HomeGate** agiscono ancora sull'intero container e fermano anche Telegram. La pausa mantiene la RAM. Un job in corso non sopravvive a un arresto completo, a un crash del worker o a un aggiornamento: completare i download prima di queste operazioni.

### Com'è fatto il container

- Un solo container. `docker/entrypoint.mjs` supervisiona il worker Telegram e avvia Next su loopback solo quando serve. Il modulo HTTP pubblico ascolta su `0.0.0.0:3000`; il worker privato è accessibile soltanto su loopback con un token casuale per ogni avvio.
- All'avvio vengono verificati archivio e webapp; dopo il primo riposo la readiness resta disponibile tramite il modulo leggero. Se il worker termina viene riavviato automaticamente. Un errore Telegram compare nello stato del bot e nei log senza rendere inaccessibile l'archivio web.
- Filesystem in sola lettura tranne `/data`, `/tmp` e `/run`; cache Next su `/tmp`. UID/GID non root arbitrari, SIGTERM entro 10 secondi, database SQLite condiviso senza migrazioni incompatibili.
- Il proxy HomeGate accetta body fino a **16 MiB**. Le connessioni SSE inviano keepalive ogni 15 secondi. Una scheda web aperta tiene attivo Next; la connessione interna di Telegram mantiene solo il container.

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

Il workflow: test → build immagine `linux/arm64`+`linux/amd64` → push su `ghcr.io/fbaz92/link-organizer` (tag `vX.Y.Z` e `stable` per comodità; il manifest usa solo il **digest immutabile**) → prova del container su entrambe le architetture (`scripts/docker-check.sh`) → promozione `stable` → commit del digest in `service.toml` → tag `vX.Y.Z` e canale `stable` sullo stesso commit.

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
pnpm test:package    # bundle estratto + Telegram simulato: polling, /stat, SIGTERM→exit 0
bash scripts/docker-check.sh   # container: build, /health, auth, RO fs, UID non root, SIGTERM
pnpm typecheck && pnpm build   # webapp standalone
```

## Limiti noti

- Arresto completo o pausa del container fermano Telegram. Il riposo automatico ordinario è gestito internamente e arresta soltanto Next. I job vivono nel worker e non sopravvivono al suo riavvio.
- Upload via web limitati a **16 MiB** per richiesta (proxy HomeGate): oltre, usa il bot.
- I tag semantici restano uno script di sviluppo (`pnpm auto-tag`): il modello locale non entra nel container.
