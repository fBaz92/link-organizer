# Compatibilità HomeGate

Stash funziona anche senza HomeGate. Il manifest `service.toml` è un adapter di distribuzione opzionale; bot, archivio e webapp non richiedono il gateway per funzionare.

## Specifiche conservate

Snapshot dei documenti ufficiali di [fBaz92/homegate](https://github.com/fBaz92/homegate/tree/43e8381a0445dcf4736b48beaf527ed35e4eb546/docs), verificato il 9 ottobre 2026:

- Versione HomeGate: **0.8.3**.
- Commit: `43e8381a0445dcf4736b48beaf527ed35e4eb546`.
- [Profilo Docker](upstream/docker-services.md).
- [Standard del manifest](upstream/service-standard.md).
- [Contratto delle release](upstream/service-release-contract.md).
- [Gestione delle applicazioni](upstream/service-management.md).
- [Connessione GitHub](upstream/github-connection.md).

I file in `upstream/` sono copie integrali, non una specifica inventata da Stash. Per aggiornarli scegliere un singolo commit upstream, sostituire tutte le copie e aggiornare versione e hash qui. Il requisito minimo dichiarato dal profilo è HomeGate 0.8.0 e Docker Engine Linux 28; la verifica documentale qui usa 0.8.3, senza garantire che le versioni precedenti abbiano tutte le stesse funzioni.

## Rispondenza del progetto

| Requisito | Implementazione e verifica |
| --- | --- |
| Manifest schema 1, versione X.Y.Z, digest immutabile, arm64/amd64 | `service.toml`, `VERSION`, workflow `docker-release.yml`, `tests/package-check.test.ts` |
| Una webapp per container, senza Compose e senza socket Docker | `Dockerfile`, `docker/entrypoint.mjs` |
| Bind su 0.0.0.0, readiness HTTP | Modulo pubblico su 0.0.0.0; Next privato su loopback; readiness iniziale di worker, database e web, poi stato del worker |
| UID/GID arbitrario non root, rootfs read-only | `scripts/docker-check.sh` prova UID 65534, mount /data, tmpfs /tmp e /run |
| Configurazione in ambiente e /config/.env, dati in /data | `src/config/env.ts`, `src/config/dotenv.ts` |
| SIGTERM entro 10 secondi | Supervisor concede 7 secondi; worker chiude SQLite e WAL; prova Docker |
| Log stdout/stderr, eventi JSON | Supervisor e `src/service/log.ts` |
| Contratto stabile tra aggiornamenti, rollback compatibile con dati | Workflow pinna il digest; schema SQLite user_version 2; non cambiare campi di distribuzione senza migrazione |

Questa è una verifica del contratto e delle prove disponibili, non una certificazione di ogni configurazione del gateway. La prova Docker include polling Telegram simulato, pagine autenticate, riposo, risveglio POST e arresto. In locale usa l'architettura della macchina; il workflow prova e pubblica entrambe le architetture. `/health` non certifica il collegamento Telegram. Il test Docker verifica sia il bot compilato contro Telegram simulato sia la disponibilità web senza credenziali Telegram.

## Riposo e lavoro in corso

Dalla 2.2.0 Stash gestisce il riposo internamente a un unico container, mantenendo ricezione Telegram e archivio nel worker leggero. Solo Next viene arrestato dopo inattività e risvegliato al primo accesso. Il timeout è 5 minuti, ridotto se HOMEGATE_IDLE_MINUTES è inferiore, oppure STASH_WEB_IDLE_SECONDS per Docker standalone e prove.

L'adapter HomeGate riconosce HOMEGATE_SERVICE_ID e apre una connessione SSE autenticata al proxy sulla porta pubblica 8790, rilevando il gateway IPv4 da /proc/net/route. STASH_HOMEGATE_PROXY_URL permette un override per reti personalizzate. La connessione usa una delle 32 richieste simultanee del proxy, invia heartbeat ogni 15 secondi e impedisce l'arresto completo secondo il contratto ufficiale sulle richieste in corso. Non richiede cambiamenti al manifest o al gateway; anche la descrizione legacy del campo HOMEGATE_IDLE_MINUTES resta invariata perché HomeGate confronta integralmente i campi environment durante gli aggiornamenti.

`/health` espone `web.state`, `bot.state` e `homegate.lease`; le sonde non risvegliano Next. Quando la connessione HomeGate manca, i log e la readiness diagnostica mostrano `failed`: occorre correggere il collegamento o abilitare temporaneamente **Sempre attivo**. In Docker standalone l'adapter è disattivato e il riposo interno funziona senza HomeGate.

Tutti i download video del container sono posseduti dal worker sempre attivo, attraverso un'interface privata su loopback autenticata da token casuale. Il riposo Next non elimina job né interrompe lavoro. Un arresto manuale, un crash del worker o un aggiornamento possono invece interrompere i job, che non sono persistiti; non si promette ripresa automatica dopo il riavvio completo. La pausa HomeGate conserva la memoria e sospende anche Telegram.

## CPU e RAM

`memory_mb = 768` e `cpus = 1.0` nel manifest sono limiti, non consumo. HomeGate legge il consumo tramite `docker stats --no-stream --format='{{json .}}' homegate-link-organizer`, includendo i processi web e bot nel container. Stash non deve esporre un endpoint metriche.

Nel codice HomeGate verificato, `ContainerService.status()` in `homegate/containers.py` usa `CPUPerc` e `MemUsage`. A container fermo o in pausa non raccoglie campioni. La dashboard distingue valori mancanti da zero. Una CPU arrotondata a 0.0% è plausibile a riposo; RAM zero con Next attivo richiede una verifica sul gateway, in particolare dei cgroup del Raspberry.

Comandi diagnostici da eseguire sul gateway, senza condividere configurazione o token:

```sh
sudo docker stats --no-stream --format '{{json .}}' homegate-link-organizer
sudo docker inspect --format '{{json .State}}' homegate-link-organizer
sudo docker info --format '{{json .Warnings}}'
```

Se Docker restituisce memoria zero, verificare gli avvisi relativi ai cgroup sul gateway. Se Docker restituisce memoria positiva e HomeGate mostra zero, il difetto è nel percorso di raccolta o visualizzazione di HomeGate. La verifica del gateway dell’utente è riportata sotto.

## Avvio senza HomeGate

Per sviluppo seguire `pnpm dev` nel README. Docker può essere eseguito direttamente con volume persistente, UID scrivibile, variabili e pubblicazione della porta:

```sh
mkdir -p data
# Preparare un file .env.docker con BOT_TOKEN, TELEGRAM_ALLOWED_USER_IDS,
# WEB_PASSWORD e WEB_APP_URL, senza committarlo.
docker build -t stash .
docker run --rm --read-only --user "$(id -u):$(id -g)" \
  --tmpfs /tmp:rw,size=64m --tmpfs /run:rw,size=16m \
  --mount "type=bind,src=$(pwd)/data,dst=/data" \
  --env-file .env.docker -e DATA_DIR=/data -p 3000:3000 stash
```

Senza HomeGate il container resta attivo finché viene arrestato. Impostare WEB_APP_URL all'indirizzo raggiungibile dal browser; l'IP stimato dentro Docker può essere soltanto interno.

## Diagnosi del gateway del 9 ottobre 2026

Verifica SSH su Raspberry Linux aarch64:

- Bundle 2.1.0 originale: `HttpError` con causa `Expected signal to be an instanceof AbortSignal`. La build esbuild rinomina la classe del polyfill, mentre node-fetch 2 confronta `constructor.name` con `AbortSignal`. La richiesta fallisce prima del trasporto.
- Build con `--keep-names`: `getMe` completa con `ok: true` nello stesso container e con la stessa configurazione, usando una copia temporanea senza modificare il processo installato.
- `node scripts/telegram-check.mjs`: prova il bundle effettivo con Telegram simulato su loopback, registra i comandi, inizializza il polling, recupera 205 link in tre lotti, verifica tutti gli item e le conferme, ritenta una risposta 429, riceve `/stat` e termina con SIGTERM. La verifica fallisce sulla build precedente ed è inclusa nelle verifiche CI e release.
- `bot_started` viene ora emesso dopo l’inizializzazione Telegram e la rimozione del webhook, senza eliminare gli aggiornamenti pendenti.
- Docker restituisce `MemUsage: 0B / 0B` e avvisi `No memory limit support`, `No swap limit support`. Il kernel contiene `cgroup_disable=memory`; `/sys/fs/cgroup/cgroup.controllers` non include `memory`. È un problema di configurazione del gateway, non di metriche pubblicate da Stash. La CPU a `0.00%` da sola non dimostra un guasto.

La correzione della build è inclusa nella 2.2.0 e nel bundle rigenerato. Nessun parametro di boot è stato modificato.

## Messaggi arretrati

Il worker salva ogni lotto ricevuto nella inbox SQLite prima di avanzare l’offset Telegram. L’elaborazione procede separatamente: gli errori restano nella inbox e vengono ritentati anche dopo un riavvio. I link sono deduplicati, quindi ripetere un aggiornamento interrotto non crea altri item. Le risposte rispettano `retry_after`; una conferma non inviata non annulla l’archiviazione né interrompe i link successivi. Gli arricchimenti sono serializzati per evitare molti processi yt-dlp contemporanei durante il recupero.

Il riposo della webapp non interrompe la ricezione. Dopo un arresto completo vengono recuperati tutti gli aggiornamenti ancora disponibili: [Telegram conserva quelli non ricevuti per massimo 24 ore](https://core.telegram.org/bots/api#getting-updates). I messaggi già ricevuti nella inbox restano invece sul volume `/data` fino all’elaborazione. Un arresto tra l’effetto di un comando e la sua registrazione può ripetere quel comando o la sua risposta; la consegna è almeno una volta.
