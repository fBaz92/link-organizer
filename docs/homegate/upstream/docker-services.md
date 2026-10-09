# Applicazioni Docker in HomeGate

Richiede HomeGate 0.8.0 e un Docker Engine Linux 28 o successivo funzionante sul gateway.
Il profilo iniziale ospita una webapp per container. Compose, database separati,
container privilegiati e accesso al socket Docker non sono supportati.
Qualsiasi linguaggio è utilizzabile se l'immagine rispetta questo contratto.

## Manifest da cui partire

Usare lo stesso `service.toml`, `VERSION`, tag e canale `stable` descritti nello
[standard dei servizi](service-standard.md). Questo esempio è completo;
sostituire repository, identità e digest prima di pubblicarlo.

```toml
schema = 1
id = "example-web"
description = "Mostra lo storico dei sensori di casa e permette di esportare le misurazioni."

[release]
repository = "owner/example-web"
runtime = "docker"
entrypoint = "service.toml"
architectures = ["arm64", "amd64"]
os = "linux"

[container]
image = "ghcr.io/owner/example-web@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
port = 3000
proxy_port = 8734
health_path = "/health"
startup_timeout = 120
memory_mb = 512
cpus = 1.0

[[environment]]
key = "HOMEGATE_IDLE_MINUTES"
label = "Riposo dopo inattività"
description = "Minuti senza richieste prima di arrestare automaticamente l'applicazione."
type = "integer"
secret = false
required = true
parameter = true
min = 1
max = 1440
default = "15"

[[environment]]
key = "API_TOKEN"
label = "Token del provider"
description = "Credenziale usata per leggere i dati dal provider."
type = "string"
secret = true
required = true

[[databases]]
id = "main"
label = "Storico sensori"
description = "Snapshot SQLite completo delle misurazioni."
required = false
path = "app.sqlite"
user_version = 1
[databases.tables]
records = ["id", "created_at", "value"]
```

`image` deve usare un digest SHA-256 immutabile; `latest` e i tag mobili sono
rifiutati. Le porte interne ammesse sono 1–65535; quella pubblica deve essere
1024–65535 e libera sul gateway. `health_path` deve restituire HTTP 2xx soltanto
quando l'app è pronta. Il timeout è 5–240 secondi, la memoria 32–32768 MiB e
il limite CPU 0.1–32 core. I tre limiti dell'esempio sono i valori predefiniti.
Il parametro di inattività deve avere tipo e vincoli dell'esempio; il valore
predefinito può essere qualsiasi intero tra 1 e 1440 minuti, inclusi.

## Configurazione e dati

Il wizard genera gli stessi campi degli altri runtime: stringhe, segreti,
interi, numeri, booleani, scelte e database SQLite. Supporta l'incolla del `.env`
e l'importazione del file, con la stessa validazione. Nessuno schema alternativo
è necessario per Docker.

HomeGate inietta le variabili nell'ambiente del processo, preservando spazi e
virgolette. Monta anche il `.env` in sola lettura come `/config/.env`. Le variabili
`HOMEGATE_CONFIG_DIR=/config`, `HOMEGATE_STATE_DIR=/data` e
`HOMEGATE_SERVICE_ID=<id>` sono impostate dal gestore. Salvare i database e ogni
altro dato persistente sotto `/data`. Il database dell'esempio è `/data/app.sqlite`.
Dopo una modifica del `.env`, usare **Riavvia servizio** per ricreare il container
con la configurazione nuova. Il parametro di inattività viene riletto direttamente.

L'immagine deve funzionare con UID/GID non root assegnati da HomeGate, senza
richiedere un utente nominato presente in `/etc/passwd`. Il filesystem è in sola
lettura, tranne `/data` e gli spazi temporanei `/tmp` e `/run`, ciascuno da 64 e
16 MiB. Non usare `/root` o la directory del codice per dati persistenti.
Non richiedere capability Linux, privilegi, dispositivi host o mount aggiuntivi.
Ascoltare su `0.0.0.0:<port>` nel container e gestire SIGTERM entro 10 secondi.

La dashboard verifica gli snapshot SQLite, arresta il processo prima di importarli
e conserva un backup. Le migrazioni dei dati restano responsabilità dell'app.
L'arresto deve chiudere le connessioni e completare le scritture in corso.

## Riposo, risveglio e controlli

La porta pubblica espone un proxy HomeGate sempre attivo. Dopo 15 minuti senza
richieste, il solo container applicativo viene fermato. La soglia è modificabile
nella pagina del servizio, da 1 a 1440 minuti.

Nella stessa pagina, **Sempre attivo** disabilita l'arresto per inattività.
La scelta è salvata sul gateway e rimane valida dopo riavvii e aggiornamenti
dell'immagine, senza modificare il manifest o il parametro dei minuti.
Arresto manuale e pausa restano disponibili; se l'app è già ferma o a riposo,
usare **Avvia servizio**. Disattivando l'opzione torna valida la soglia configurata.
Il salvataggio ricarica il proxy attivo per applicare anche gli aggiornamenti di
HomeGate; le connessioni HTTP aperte possono interrompersi brevemente.

Al primo accesso il container riparte. Gli avvii contemporanei sono messi in coda,
uno alla volta sul gateway.
La pagina di attesa si aggiorna ogni 3 secondi e mostra l'app soltanto dopo la
readiness HTTP. Un avvio fallito viene ritentato con un intervallo minimo di
30 secondi e segnalato nei log.

**Arresta servizio** impedisce il risveglio automatico fino a **Avvia servizio**.
**Metti in pausa** congela i processi del container, che mantengono la memoria;
**Riprendi servizio** li riattiva. Le richieste a un'app arrestata o in pausa
mostrano una pagina informativa. Un aggiornamento richiede prima di avviare o
riprendere un container fermato manualmente o in pausa.

Le richieste in corso, comprese connessioni WebSocket e SSE, impediscono il riposo.
I controlli interni `/_homegate/ready` non contano come attività e non risvegliano
l'app. Il prefisso `/_homegate/` è riservato. Gli accessi di monitor esterni alle
normali pagine contano invece come attività.

Durante l'avvio le richieste restituiscono HTTP 503 con `Retry-After: 3`.
GET/HEAD con `Accept: text/html` ricevono la pagina cortese; gli altri client
ricevono JSON. POST e upload non vengono ripetuti automaticamente: il client deve
attendere e inviarli nuovamente. Sono ammessi body fino a 16 MiB con un solo
`Content-Length`; il trasferimento chunked delle richieste è rifiutato. Le risposte
sono trasmesse in streaming, con timeout di lettura di 30 secondi: SSE deve inviare
keepalive più frequenti. Sono ammesse fino a 32 connessioni simultanee per proxy.
Il profilo serve HTTP nella LAN; un eventuale HTTPS esterno richiede un proxy TLS.

## Log e metriche

Scrivere i log su stdout/stderr, preferibilmente come un oggetto JSON per riga,
con `event`, `level` e un messaggio leggibile. HomeGate legge i log Docker nella
pagina del servizio e nel selettore della pagina Log, con eventi recenti per primi,
dettagli espandibili e oscuramento dei campi sensibili conosciuti. Non stampare
credenziali: l'oscuramento non può riconoscere ogni testo libero.

La pagina mostra CPU e memoria del container, stato, tempo dall'avvio e parametri.
La rotazione conserva fino a tre file da 5 MiB per container; la dashboard legge
al massimo 200 eventi dalle ultime 24 ore. La ricreazione del container elimina
il suo log precedente. I dati in `/data` restano persistenti.

## Pubblicare e aggiornare

1. Costruire e testare un'immagine Linux per le architetture dichiarate. Pubblicarla
   nel registry e ottenere il digest, eventualmente dell'indice multiarch.
2. Scrivere il digest in `service.toml`, aggiornare `VERSION`, committare e creare
   il tag `vX.Y.Z`. Promuovere `stable` a quel commit solo dopo i test.
3. Usare **Aggiungi servizio**, scegliere la repo e completare il wizard.
   L'URL viene generato usando IP LAN del gateway e `proxy_port`.
4. Dalla pagina del servizio usare **Cerca aggiornamenti** e installare la release.
   HomeGate scarica l'immagine prima di cambiare quella attiva, verifica la
   readiness e ripristina la release precedente in caso di errore.

Il codice Git continua a provenire dalla release verificata; il container viene
scaricato dal registry usando il digest nel manifest. Il token della GitHub App
con accesso Contents non autorizza automaticamente un registry privato. Usare
un'immagine pubblica oppure predisporre separatamente `sudo docker login` con
credenziali di sola lettura del registry. Non inserire quelle credenziali nel
manifest o nel `.env` dell'app.

Tra release può cambiare il digest dell'immagine e la descrizione. Porte, limiti,
readiness, contratto `release`, campi `environment` e `databases` devono restare
compatibili e invariati. Una variazione richiede una migrazione locale esplicita.
Il rollback ripristina codice e immagine, conserva i dati e richiede quindi che
la versione precedente possa ancora leggere i dati scritti dalla nuova.

## Preparare il gateway

L'analisi blocca l'installazione se Docker non è disponibile. Installare il motore
come operazione amministrativa separata, preservando il forwarding e le regole
DNS/VPN/Tailscale del gateway. Non esporre l'API Docker sulla rete e non aggiungere
l'account dell'app al gruppo `docker`. La porta interna del container è pubblicata
solo su loopback; l'unico ingresso LAN è il proxy gestito.

Sono richieste le correzioni del binding loopback introdotte in Docker 28.
Vedi [pubblicazione delle porte Docker](https://docs.docker.com/engine/network/port-publishing/)
e [Docker su un router](https://docs.docker.com/engine/network/packet-filtering-firewalls/#docker-on-a-router).
