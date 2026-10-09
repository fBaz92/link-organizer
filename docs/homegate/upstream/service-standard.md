# Standard per nuove applicazioni HomeGate

Il wizard e i campi descritti richiedono HomeGate 0.6.0 o successivo.

Questo è il documento canonico per preparare una nuova repo GitHub, registrarla
su un Raspberry e aggiornarla tramite HomeGate. Descrive il formato implementato
in `homegate/service_updates.py`. Per configurazione, importazione SQLite e uso
della dashboard vedere [gestione delle applicazioni](service-management.md).

HomeGate installa e aggiorna applicazioni conformi tramite la dashboard.
Il percorso **Servizi → Aggiungi servizio** collega GitHub, elenca le repo,
verifica una release e guida alla configurazione prima dell'installazione.
Il runtime richiesto deve essere già disponibile sul Raspberry; l'analisi indica
un runtime assente o troppo vecchio e impedisce l'installazione. Il provisioning
manuale descritto più avanti rimane un'alternativa per l'operatore.

## Installazione guidata dalla dashboard

1. Aprire **Servizi → Aggiungi servizio**. Con **Accedi con GitHub** usare
   il codice di autorizzazione della GitHub App, dopo averla installata sulle repo
   scelte con **Contents: Read-only** e **Metadata: Read-only**. Vedi
   [Collegare GitHub](github-connection.md). In alternativa, **Usa un token
   personale** accetta un token fine-grained con gli stessi permessi e una
   scadenza. HomeGate non può dimostrare che un token personale fornito
   dall'utente non abbia altri permessi.
2. Scegliere una repo dall'elenco accessibile alla connessione. La ricerca filtra
   le repo già caricate; usare il pulsante per caricare le pagine successive.
3. Avviare l'analisi. Sono richiesti `stable`, `VERSION`, tag corrispondente e
   `service.toml` conforme. HomeGate verifica archivio, entrypoint, runtime,
   architettura e collisioni con servizi esistenti. Non deduce un deploy sicuro
   da un semplice `package.json` e non esegue codice della repo come root.
4. Compilare i campi generati dal manifest oppure incollare un `.env` come testo
   o file. Caricare eventuali snapshot SQLite e verificarne la conformità.
   Senza un file iniziale, l'applicazione deve creare il proprio database.
5. Scegliere nome e URL facoltativo, controllare versione e repo nel riepilogo
   e installare. Viene installato il commit verificato durante l'analisi,
   anche se `stable` nel frattempo cambia.

Le credenziali vengono salvate soltanto sul dispositivo, in file con permessi
`600`, e non vengono restituite al browser. L'accesso con GitHub App rinnova
automaticamente i token. Gli aggiornamenti futuri dei servizi installati dal
wizard usano questa connessione. Scollegare o revocare GitHub impedisce nuovi
download; i processi già installati continuano a girare. Le applicazioni
provisionate con una deploy key dedicata continuano a usare SSH.

L'installazione crea un account dedicato `hg-<hash>`, un'unità
`homegate-app-<id>.service`, codice e percorsi persistenti. Registra il servizio
soltanto dopo il controllo del processo. Se il primo avvio fallisce, tenta di
arrestare il processo e rimuovere le sole risorse create da quella installazione.
Una transazione interrotta viene recuperata al boot dalla unità HomeGate dedicata.
I piani e i dati temporanei sono privati del gestore in
`/var/lib/homegate/enrollment`; il browser invia l'identificativo del piano e
non decide comandi, percorsi o contenuto dell'unità.

L'analisi verifica la compatibilità dichiarata e strutturale. Non garantisce la
correttezza del codice o dei dati di business: restano necessari i test della repo.

## Preparare il repository

Ogni repo ha un'identità stabile, uguale in manifest e registrazione locale.
Usare da 1 a 41 caratteri, iniziando con una lettera minuscola e proseguendo
con lettere minuscole, cifre e trattini; `heartbeat` e il prefisso `core-` sono
riservati. L'esempio usa `example-worker` e `owner/example-worker`: sostituirli
con l'identità e il repository reali prima della prima installazione.

```text
VERSION
service.toml
dist/main.js
package.json
.env.example
tests/
.github/workflows/release.yml
```

`VERSION` contiene una versione finale `X.Y.Z`, senza prefisso `v`, per esempio
`1.0.0`. `service.toml` contiene il contratto seguente:

```toml
schema = 1
id = "example-worker"
description = "Raccoglie i dati dei sensori e mostra lo storico tramite una webapp nella rete di casa."

[release]
repository = "owner/example-worker"
runtime = "node"
entrypoint = "dist/main.js"
runtime_min = "22.0.0"
architectures = ["arm64", "amd64"]
os = "linux"

[[environment]]
key = "PORT"
label = "Porta HTTP"
description = "Porta su cui la webapp ascolta nella LAN"
type = "integer"
secret = false
required = true
parameter = true
min = 1024
max = 65535
default = "8734"
```

La sezione `release` richiede tutti i campi dell'esempio tranne `runtime_min`.
Il runtime è `node`, `python`, `binary` o `docker`; il sistema è `linux`.
Il profilo Docker richiede HomeGate 0.8.0: seguire [applicazioni Docker](docker-services.md)
per il manifest completo, readiness, riposo e risveglio. Usa gli stessi campi
`environment` e `databases` e lo stesso wizard.
`runtime_min` è una versione completa `X.Y.Z` ed è ammessa solo per Node/Python.
Le architetture canoniche sono `arm64`, `amd64` e `armv7`; il validatore riconosce
anche gli alias `aarch64`, `x86_64` e `armv7l`. Dichiarare solo target provati.
Un Raspberry con sistema a 32 bit richiede `armv7`, anche se il processore
supporta 64 bit.

`entrypoint` indica un file ordinario relativo alla release. Sono ammessi
lettere ASCII, cifre, `_`, `.`, `/` e `-`. Percorsi assoluti, segmenti vuoti,
`.` e `..` sono rifiutati. Il file deve essere eseguibile per `binary`.
La sezione `release` rifiuta attributi sconosciuti. Non aggiungere sezioni
ipotetiche per build, argv o migrazioni: HomeGate non le interpreta.
La readiness HTTP è supportata soltanto dal profilo Docker tramite `[container]`.

Il pacchetto distribuito è il contenuto del commit Git, ottenuto con
`git archive`. `dist/main.js` deve quindi essere tracciato nel commit della
release, anche quando il sorgente originale è TypeScript. HomeGate non scarica
asset allegati alle GitHub Release. La sorgente limita l'archivio a 20 MiB e il
motore limita il contenuto estratto a 20 MiB. Sono ammessi solo file e directory
ordinari, senza link simbolici, hard link o file speciali.

## Un'applicazione Node completa

Questo `dist/main.js` usa solo moduli inclusi in Node. Il file `.env.example`
contiene `PORT=8734`; il `.env` reale resta sul dispositivo.

```javascript
import { createServer } from 'node:http';

const port = Number(process.env.PORT);
if (!Number.isInteger(port) || port < 1024 || port > 65535) {
  throw new Error('PORT non valida');
}
const server = createServer((request, response) => {
  response.setHeader('Content-Type', 'application/json');
  response.end(JSON.stringify({ status: 'ok', path: request.url }));
});
server.listen(port, '0.0.0.0', () => {
  console.log(JSON.stringify({ event: 'started', port }));
});
process.on('SIGTERM', () => {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 25000).unref();
});
```

Aggiungere `package.json` con `{"type":"module"}` alla repo. Per applicazioni
reali, compilare e testare in CI un bundle di produzione autonomo. Eventuali
`node_modules` devono essere tracciati nel commit, privi di link e compatibili
con il target, restando nei limiti dell'archivio. HomeGate non esegue `npm ci`,
script npm, compilazioni TypeScript o hook del repository durante l'update.

Il processo resta in foreground, scrive log su stdout/stderr e gestisce
SIGTERM. Per i log strutturati emettere un oggetto JSON completo su una sola
riga per evento, senza pretty printing. Usare `event` come identificatore stabile
e `summary` per una descrizione leggibile; non registrare segreti. La dashboard
mostra ogni campo JSON nei dettagli. Un traceback o testo libero può restare testo.

Da HomeGate 0.7.0 la pagina del servizio permette arresto/avvio e, per processi
persistenti su cgroup v2, pausa/ripresa. La pausa conserva la memoria, sospende
tutti i processi del servizio e impedisce risposte fino alla ripresa. Le unità
oneshot e i timer non espongono pausa. L'arresto non disabilita l'avvio al boot;
considerare eventuali timer, socket e dipendenze che riattivano il servizio.
 Dati persistenti e cache applicative vanno in
`/var/lib/homegate/services/example-worker`, mai nella release. L'esempio HTTP
ascolta su tutte le interfacce per consentire l'accesso dalla LAN: scegliere
bind e restrizioni di rete in base al dispositivo. Registrare l'URL non apre
porte nel firewall e non configura un reverse proxy.

## Descrizione leggibile del servizio

Da HomeGate 0.7.1 ogni nuova repo deve dichiarare `description` alla radice di
`service.toml`, accanto a `schema` e `id`. Scrivere una frase che spieghi cosa fa
l'applicazione e a cosa serve per chi gestisce la casa. Evitare nomi di unità,
identificativi tecnici o elenchi di tecnologie come unica descrizione.

La descrizione deve contenere da 10 a 600 caratteri, almeno tre parole e nessun
carattere di controllo. Il wizard rifiuta manifest senza descrizione o con valori
non validi; mostra la frase prima del setup e la conserva nella registrazione
locale. Schede, tabella e dettaglio mostrano la descrizione e la ricerca la include.
Le release di un'app già registrata con descrizione devono continuare a fornirla.

Le installazioni precedenti restano leggibili. HomeGate include descrizioni
specifiche per i propri servizi di sistema e per Heartbeat email. Per un'app
registrata manualmente, aggiungere la stessa descrizione al manifest locale o
il campo `description` in `[[addons]]`; quest'ultimo offre anche un ripiego per
applicazioni senza manifest. La descrizione nel manifest ha precedenza.

## Alternative Python e binarie

Per Python sostituire soltanto `release` nel manifest completo:

```toml
[release]
repository = "owner/example-worker"
runtime = "python"
entrypoint = "app/main.py"
runtime_min = "3.11.0"
architectures = ["arm64", "amd64"]
os = "linux"
```

L'unità avvia `/usr/bin/python3` con il percorso dell'entrypoint sotto `current`.
HomeGate verifica la versione del Python con cui gira la propria CLI e compila
i file Python senza eseguire il programma candidato. Usare lo stesso interprete
nell'unità. Le dipendenze devono essere già provisionate dall'operatore oppure
incluse come file rilocabili nella repo e importabili dall'applicazione.
HomeGate non crea venv e non esegue `pip install`. Una venv copiata dalla CI o
creata nello staging può contenere percorsi che cambiano dopo l'attivazione.

Per un binario sostituire `release` con:

```toml
[release]
repository = "owner/example-worker"
runtime = "binary"
entrypoint = "bin/example-worker"
architectures = ["arm64"]
os = "linux"
```

Tracciare il permesso eseguibile nel commit e avviare direttamente il file sotto
`current`. Non dichiarare `runtime_min`. Testare architettura, loader e librerie
sul target; HomeGate verifica la dichiarazione di architettura, non analizza il
formato ELF o la compatibilità libc. Un singolo entrypoint deve funzionare su
ogni architettura dichiarata. Non viene selezionato un asset diverso per target.
Java, wrapper shell, process manager e runtime personalizzati non sono profili
supportati dal contratto attuale.

## Provisioning manuale alternativo e permessi

Se non si usa il wizard, l'operatore completa questi passaggi:

1. Provisiona Node/Python o le librerie richieste dal binario. Per Node,
   l'eseguibile rilevato da `PATH`, il suo percorso risolto e gli antenati devono
   appartenere a root e non essere scrivibili dal gruppo o da altri utenti.
2. Crea un utente e un gruppo dedicati, per esempio `example-worker`, con UID
   diverso da zero. L'unità deve usare un account persistente, senza `DynamicUser`.
3. Verifica una release iniziale e la colloca nelle directory sotto indicate.
   Codice, manifest fidato e chiave di deploy restano controllati dall'operatore.
4. Installa il manifest locale verificato, configura il `.env`, registra
   l'applicazione in `site.toml` e installa l'unità systemd.
5. Installa l'integrazione HomeGate con `sudo homegate services-install`, ricarica
   systemd e abilita l'unità applicativa. Verifica log, configurazione e dati prima
   di considerare conclusa l'installazione.

```text
/opt/homegate/services/example-worker/
  releases/1.0.0-<commit>/          # codice controllato da root, leggibile dall'app
  current -> releases/1.0.0-<commit>
/etc/homegate/services/example-worker/
  service.toml                     # contratto locale fidato
  .env                             # configurazione locale
  deploy_ed25519                   # chiave GitHub di sola lettura
/var/lib/homegate/service-updates/example-worker/  # stato e cache di HomeGate
/var/lib/homegate/services/example-worker/         # dati scrivibili dall'app
```

`current` è un link alla directory immediatamente sotto `releases`. Le directory
che lo contengono e quelle dello stato dell'updater sono directory reali, senza
link. Nella variante manuale SSH, la chiave è dedicata al repository e leggibile solo da root, normalmente
con permessi `600`. Le host key GitHub fidate sono in
`/etc/homegate/github_known_hosts`; verificarle durante il provisioning.
Il manifest locale non deve essere modificabile dall'applicazione. La dashboard
scrive `.env` con permessi `600` e proprietà dell'utente effettivo dell'unità;
configurare gli stessi permessi durante l'enrollment. Consentire all'utente di
attraversare le directory antenate e leggere il codice, senza concedergli
scrittura su release, collegamenti o stato dell'updater.

Registrazione effettiva in `/etc/homegate/site.toml`:

```toml
[[addons]]
id = "example-worker"
name = "Example Worker"
unit = "example-worker.service"
url = "http://192.168.1.2:8734/"
```

Usare l'indirizzo reale del Raspberry. `url` è facoltativo e ammette HTTP/HTTPS
senza credenziali incorporate; abilita il pulsante **Apri webapp**, che apre
l'interfaccia web sviluppata nella repo dell'applicazione. HomeGate genera i
campi di configurazione e i parametri operativi della propria dashboard dalle
sezioni `environment` e dai flag `parameter`. La webapp resta responsabile delle
proprie funzioni: non è richiesto un SDK frontend o un framework particolare.
L'identità e
l'unità devono essere uniche. La dashboard rilegge la configurazione tramite i
meccanismi già previsti dal dispositivo; riavviare il pannello dopo un enrollment
manuale per caricare la nuova registrazione.

Esempio `/etc/systemd/system/example-worker.service` per Node installato in
`/usr/bin/node`:

```ini
[Unit]
Description=Example Worker
Requires=homegate-services-recover.service
After=homegate-services-recover.service network-online.target
Wants=network-online.target

[Service]
Type=exec
User=example-worker
Group=example-worker
WorkingDirectory=/opt/homegate/services/example-worker/current
EnvironmentFile=/etc/homegate/services/example-worker/.env
Environment=HOMEGATE_SERVICE_ID=example-worker
Environment=HOMEGATE_STATE_DIR=/var/lib/homegate/services/example-worker
Environment=HOMEGATE_CONFIG_DIR=/etc/homegate/services/example-worker
ExecStart=/usr/bin/node /opt/homegate/services/example-worker/current/dist/main.js
StateDirectory=homegate/services/example-worker
StateDirectoryMode=0700
UMask=0077
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
CPUAccounting=true
MemoryAccounting=true
TimeoutStopSec=30

[Install]
WantedBy=multi-user.target
```

Adattare l'interprete al percorso realmente verificato sull'host. Per Python,
`ExecStart=/usr/bin/python3 /opt/homegate/services/example-worker/current/app/main.py`.
Per binary, `ExecStart=/opt/homegate/services/example-worker/current/bin/example-worker`.
Il validatore richiede l'entrypoint esatto sotto `current` e l'interprete
verificato come eseguibile principale; un wrapper shell non soddisfa il controllo.
I tipi systemd ammessi sono `simple`, `exec`, `notify` e `notify-reload`.
La dipendenza dalla unità di recupero ripristina i collegamenti delle transazioni
interrotte prima dell'avvio applicativo. Non sostituisce un backup dei dati.

Il wizard espone al processo `HOMEGATE_SERVICE_ID`, `HOMEGATE_STATE_DIR` e
`HOMEGATE_CONFIG_DIR`. Usare queste variabili per individuare identità, dati e
configurazione senza dipendere dal percorso del codice. Sono metadati riservati:
non dichiararli tra i campi `environment`. Nel provisioning manuale configurarli
come nell'unità di esempio.

## Configurazione e SQLite

`environment` descrive fino a 128 variabili `.env`; i tipi ammessi sono `string`,
`integer`, `number`, `boolean` ed `enum`. Usare `options` per enum, `min`/`max`
per numeri e default come stringhe conformi al tipo. `secret` vale `true` se
omesso; un default è ammesso solo per campi non segreti. `parameter = true`
identifica una scelta operativa. I valori booleani sono `true` e `false`.
Il manifest descrive i campi, non contiene credenziali. I default presentati
dalla dashboard vanno salvati nel `.env`: l'updater non li inietta nel processo.

Il manifest è anche la specifica del wizard. Non occorre scrivere un secondo
schema frontend: aggiungere un campo `environment` lo fa comparire sia nel
setup sia nella pagina del servizio. `label` dà il titolo, `description` spiega
cosa inserire, `required` impedisce di proseguire senza un valore. I parametri
operativi sono variabili `.env` con `parameter = true` e un tipo esplicito.

Per esempio, queste dichiarazioni aggiungono credenziali e controlli al wizard:

```toml
[[environment]]
key = "API_TOKEN"
label = "Token del provider"
description = "Genera un token di lettura nel pannello del provider"
type = "string"
secret = true
required = true

[[environment]]
key = "INTERVAL_MINUTES"
label = "Frequenza in minuti"
type = "integer"
secret = false
parameter = true
required = true
default = "60"
min = 5
max = 10080

[[environment]]
key = "ENABLED"
label = "Abilitato"
type = "boolean"
secret = false
parameter = true
default = "false"

[[environment]]
key = "MODE"
label = "Modalità"
type = "enum"
secret = false
parameter = true
options = ["normal", "quiet"]
default = "normal"
```

Sono supportati anche decimali con `type = "number"` e vincoli `min`/`max`.
Le descrizioni sono testo semplice fino a 500 caratteri. Il manifest non
contiene credenziali reali e non esegue formule o comandi.

Un database si dichiara così, dopo i campi `environment`:

```toml
[[databases]]
id = "main"
label = "Archivio applicativo"
description = "Snapshot SQLite completo del servizio"
required = false
path = "app.sqlite"
user_version = 1

[databases.tables]
records = ["id", "created_at", "value"]
```

`required = true` richiede nel wizard un file SQLite iniziale conforme prima
dell'installazione. Se omesso o `false`, l'upload è facoltativo e l'app può creare
il database al primo avvio. Questo flag riguarda il setup iniziale; la repo resta
responsabile della gestione del database durante l'esecuzione. Il wizard mostra
`label` e `description` e controlla il file rispetto a `user_version` e `tables`.
I percorsi dei database dichiarati devono essere distinti.

Il percorso è relativo ai dati applicativi, quindi il file dell'esempio è
`/var/lib/homegate/services/example-worker/app.sqlite`. Sono ammessi fino a 16
database dichiarati. La dashboard verifica file SQLite fino a 16 MiB, integrità,
versione se presente, tabelle e colonne; non crea il database e non esegue
migrazioni. L'applicazione gestisce il proprio schema. Consultare
[gestione delle applicazioni](service-management.md) per importazione, backup,
WAL, segreti e limiti del `.env`.

## Pubblicare e aggiornare

Per ogni nuova release:

1. Eseguire test e build in CI, incluse le prove sul target dichiarato. Tracciare
   il pacchetto finale nella repo, con `VERSION` e `service.toml` coerenti.
2. Creare un tag immutabile `vX.Y.Z` sul commit della release. Sono ammessi tag
   leggeri e annotati. Pubblicare una GitHub Release è utile per le note, ma
   l'updater verifica Git e non richiede l'oggetto GitHub Release.
3. Promuovere `stable` allo stesso commit del tag. `VERSION` di quel commit deve
   contenere esattamente `X.Y.Z`. Una correzione richiede versione e tag nuovi.
4. Nella dashboard Servizi cercare gli aggiornamenti della singola applicazione
   e installare la release, oppure eseguire `sudo homegate service-update example-worker`.

HomeGate ricontrolla contratto, target, runtime e unità; prepara lo staging,
attiva `current`, riavvia soltanto l'unità associata e verifica per due secondi
che systemd la segnali `active`, con PID e contatore dei riavvii stabili.
Lo stesso controllo segue il ripristino della release precedente. In caso di fallimento tenta di ripristinare la release precedente
e blocca il commit fallito. Dopo aver risolto la causa, il comando esplicito
`sudo homegate service-update example-worker --retry` permette di riprovarlo.
`sudo homegate services-recover` recupera soltanto i collegamenti delle
applicazioni con transazioni interrotte, senza riavviare i processi. Per usarlo
manualmente, arrestare prima le unità applicative interessate e riavviarle dopo
il recupero. Al boot, le dipendenze dell'unità applicativa assicurano questo
ordine automaticamente. Non è un comando di installazione o migrazione.

Non esistono ancora timer notturni o pianificazione dalla dashboard per queste
applicazioni; la pianificazione di HomeGate riguarda il gateway stesso.
La finestra di due secondi rileva anche crash e riavvii immediati, senza garantire
readiness HTTP, correttezza delle risposte o salute delle dipendenze. La repo
mantiene test e monitoraggio applicativo propri.

## Compatibilità fra release e dati

Le sezioni `release`, `environment` e `databases` della candidata devono essere
uguali a quelle del manifest locale fidato, compresi default, ordine degli array
e campi opzionali. Cambiare repository, runtime, entrypoint, architetture,
variabili o schema richiede una migrazione locale esplicita del contratto.
Un cambiamento puramente applicativo conserva queste sezioni e aumenta la
versione. Gli aggiornamenti gestiti accettano solo versioni superiori con
lo stesso numero principale; `1.x` verso `2.x` richiede gestione manuale.

Il rollback ripristina codice e collegamenti, non i dati. Ogni release aggiornabile
deve lasciare i dati leggibili dalla precedente. Per migrazioni incompatibili,
arrestare l'applicazione, conservare un backup consistente, applicare una
procedura documentata e aggiornare contratto e release iniziale localmente.
Non affidare una migrazione distruttiva all'avvio di una candidata.

La CI deve provare avvio del pacchetto estratto senza strumenti di sviluppo,
arresto ordinato, esecuzione da un percorso diverso dalla build, assenza di
scritture nella release e compatibilità dei dati dopo rollback. Queste prove
completano i controlli eseguiti da HomeGate sul dispositivo.
