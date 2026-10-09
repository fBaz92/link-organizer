# Gestione delle applicazioni HomeGate

La pagina Servizi mostra le unità HomeGate, le applicazioni registrate in
`site.toml` e il servizio Heartbeat email. Ogni voce mostra una descrizione leggibile del proprio scopo e ha un dettaglio con stato,
tempo di attività, memoria, CPU, riavvii e log. CPU indica il consumo rispetto
a un core e può superare il 100%. Il primo campione non ha una percentuale;
valori non esposti dal kernel o da systemd sono indicati come non disponibili.
Il dettaglio mostra **Apri webapp** quando il servizio ha un URL: Pi-hole usa la
propria pagina `/admin/`; per le altre applicazioni impostare `url` in `[[addons]]`.
Il link apre in una nuova scheda l'interfaccia sviluppata nella repo
applicativa. La dashboard HomeGate genera configurazione e parametri da
`environment` e `parameter`; non richiede un SDK frontend alla webapp.
I servizi senza interfaccia web non hanno il pulsante.

## Ricerca, risorse e comandi

Da HomeGate 0.7.0 la lista permette ricerca per nome, unità o repo, filtri per
stato e origine, schede o tabella e ordinamento crescente/decrescente per nome,
memoria e CPU. I valori non disponibili restano in fondo in entrambi i versi.
Filtri e vista si conservano quando si apre un dettaglio e si torna alla lista,
finché la pagina resta aperta.

Il dettaglio offre Avvia, Arresta, Metti in pausa e Riprendi quando applicabili.
Ogni azione richiede conferma e ricontrolla sul server lo stato sotto il lock
condiviso delle modifiche. Arrestare non disabilita l'avvio al boot: timer o
dipendenze possono riattivare un'unità. Arrestare DNS, Wi-Fi o VPN può interrompere
la connettività. Dashboard, ACL DNS e timer di protezione sono protetti.

La pausa usa `systemctl freeze` per sospendere l'intero gruppo dei processi,
conservando memoria e dati in RAM; Riprendi usa `systemctl thaw`. È disponibile
per servizi con processo attivo, tipo persistente e gerarchia cgroup v2.
I timer e le unità oneshot non espongono pausa. Heartbeat email si disabilita dal
campo `ENABLED`, perché il suo timer riavvierebbe una singola esecuzione arrestata.

I risultati CLI sono JSON su una sola riga, per evitare che journald li spezzi.
La lettura recupera anche i vecchi blocchi JSON completi entro cinque secondi e
64 KiB, senza unire processi o invocazioni distinti. Blocchi incompleti restano
righe separate. I controlli DNS mostrano resolver attivo e conteggi consecutivi;
i dettagli mantengono tutti i campi e oscurano i segreti.

## Attivare la gestione su un dispositivo esistente

Dopo aver aggiornato il codice, eseguire una volta:

```sh
sudo homegate services-install
```

Il comando installa manifest, utente dedicato e timer dell'heartbeat. Non
riavvia DNS, VPN o Wi-Fi e conserva il `.env` esistente. Installa anche
la unità di recupero delle applicazioni; le unità applicative devono dichiarare
la dipendenza descritta nello standard canonico. Migra i permessi
delle directory e dei file del codice, incluse le sottocartelle estratte con
`umask 077`, e consente agli utenti dedicati di attraversare
`/etc/homegate` e `/var/lib/homegate` senza elencarne il contenuto; i file
privati conservano i propri permessi. Una nuova installazione
tramite `homegate install` include questi file. Il timer controlla ogni minuto
se è arrivato il momento dell'invio; la frequenza effettiva dipende dal campo
`INTERVAL_MINUTES`. L'invio è disabilitato finché `ENABLED` non è `true`.

Il dettaglio di un'applicazione senza manifest mostra metriche e log, ma non
abilita modifiche a configurazione o dati. Per installare una repo conforme usare
**Servizi → Aggiungi servizio**: collegare GitHub, scegliere la repo, analizzare
la release e seguire i passaggi per configurazione, database e installazione.
Il runtime deve essere presente sul dispositivo. La pagina non esegue comandi
shell arbitrari o build hook della repo come root.

## Standard delle altre repo

Per creare una nuova repo, abilitarne gli aggiornamenti GitHub o provisionare
la sua unità leggere lo [standard canonico delle applicazioni](service-standard.md).
Il wizard esegue l'enrollment iniziale; resta disponibile il provisioning manuale.
Le applicazioni già registrate con una sezione
`release` valida possono cercare e installare aggiornamenti dal dettaglio Servizi;
le altre conservano metriche, log e gestione locale disponibili.

Una repo deve fornire un `service.toml` che dichiara i campi gestibili e gli
schemi SQLite. L'esempio seguente descrive soltanto la gestione di configurazione
e dati: aggiungere la sezione `release` dello standard canonico per abilitare gli
aggiornamenti. Il [riferimento al contratto delle release](service-release-contract.md)
riassume il formato supportato.
Il wizard installa il manifest verificato; nel provisioning manuale copiarlo in
`/etc/homegate/services/<id>/service.toml`; il browser non può caricarne uno
arbitrario. La repo resta responsabile di avviare il proprio codice con il `.env`
locale e di leggere/scrivere i database nelle directory dichiarate.

Esempio per un'applicazione Node; lo stesso formato si usa per Python o binari:

```toml
schema = 1
id = "example-worker"
description = "Raccoglie i dati dei sensori e mostra lo storico nella rete di casa."

[[environment]]
key = "API_TOKEN"
label = "Token del provider"
type = "string"
secret = true
required = true

[[environment]]
key = "INTERVAL_MINUTES"
label = "Frequenza in minuti"
type = "integer"
secret = false
parameter = true
min = 5
max = 10080
default = "60"

[[environment]]
key = "ENABLED"
label = "Abilitato"
type = "boolean"
secret = false
parameter = true
default = "false"

[[databases]]
id = "main"
label = "Archivio applicativo"
path = "app.sqlite"
user_version = 1

[databases.tables]
records = ["id", "created_at", "value"]
```

L'applicazione va anche registrata in `site.toml`:

```toml
[[addons]]
id = "example-worker"
name = "Example Worker"
unit = "example-worker.service"
url = "https://worker.example.com/" # facoltativo per servizi con interfaccia web
```

`heartbeat` e gli identificativi che iniziano con `core-` sono riservati.
Non registrare due applicazioni per la stessa unità systemd. Il percorso di un
database è relativo a `/var/lib/homegate/services/<id>`; sono rifiutati percorsi
assoluti, traversal e link simbolici.

I tipi di campo ammessi sono `string`, `integer`, `number`, `boolean` ed `enum`.
Per `enum`, dichiarare `options = ["valore-a", "valore-b"]`. `min` e `max`
vincolano i numeri. I default devono essere stringhe conformi al tipo dichiarato
ed essere non segreti. Il valore predefinito di `secret` è `true`; dichiarare
`secret = false` solo quando il campo può essere mostrato dopo il salvataggio.
`parameter = true` identifica una scelta operativa come la frequenza, che resta
una variabile `.env` tipizzata. Campi sconosciuti, duplicati e valori non conformi
sono rifiutati. La dashboard non esegue espressioni del manifest.

## `.env`, segreti e modifiche

Il file locale è `/etc/homegate/services/<id>/.env`. È scritto atomicamente con
permessi `600`, assegnato all'utente effettivo dell'unità systemd. Le directory
consentono l'accesso al suo gruppo. La repo deve usarlo esplicitamente, per esempio
tramite `EnvironmentFile=` nell'unità o un lettore dotenv letterale.

Nella pagina si possono incollare assegnazioni `CHIAVE=valore`, incollare un file
presente negli appunti oppure selezionare un `.env`. La verifica riconosce solo
le chiavi dichiarate nel manifest e compila i campi prima del salvataggio.
Sono supportati commenti, prefisso `export`, valori con apici singoli e stringhe
con doppi apici ed escape JSON. Non sono eseguite espansioni `${VAR}`, `$()` o
comandi: i caratteri restano dati letterali. Valori su più righe sono rifiutati.
Il limite del file è 64 KiB.

Le risposte di lettura non contengono i valori segreti salvati. Un campo segreto
vuoto conserva il valore precedente; la cancellazione è esplicita. La preview
restituisce soltanto i valori appena importati dall'utente. Il salvataggio valida
anche i campi obbligatori dell'insieme risultante. Dopo il salvataggio, il riavvio
è un'operazione esplicita; il pannello non può riavviare sé stesso da una richiesta.

La connessione della dashboard attuale è HTTP: usare una rete fidata o un proxy
HTTPS per l'inserimento di credenziali. I valori non finiscono negli asset statici,
nei log di audit o nel repository. I segreti in memoria del browser vengono
rimossi cambiando pagina, ma i file e gli appunti restano sotto il controllo
dell'operatore.

## Conformità e importazione SQLite

La dashboard accetta un solo file SQLite, fino a 16 MiB. Controlla intestazione,
integrità, `user_version` se dichiarato, tabelle e presenza delle colonne richieste.
Il controllo non esegue migrazioni né query applicative. Tabelle aggiuntive sono
ammesse. Una conformità strutturale non dimostra la validità di ogni riga o dei
vincoli di business: la repo deve mantenere test propri su quei dati.

Usare uno snapshot SQLite completo, ottenuto mediante l'API di backup o con
l'applicazione arrestata. Copiare soltanto il file principale mentre sono in corso
scritture WAL può produrre un archivio incompleto anche se il file è leggibile.

La verifica del file non modifica l'applicazione. L'importazione richiede una
conferma separata e ripete la verifica sul contenuto ricevuto. HomeGate arresta
l'unità e ne verifica l'arresto, crea un backup del database corrente comprensivo
del WAL, sostituisce il file e riavvia soltanto se l'unità era attiva. In caso di
errore gestito ripristina il database precedente e prova a riavviare l'applicazione.
Il backup è `<nome-file>.backup` e viene sostituito al prossimo import riuscito.

Non è ancora implementato un recupero automatico dell'importazione dopo
interruzione elettrica. In quel caso arrestare l'applicazione, conservare tutti
i file presenti e verificare il backup prima di ripristinarlo. Non eliminare
sidecar WAL di un database in esecuzione. Il backup locale non sostituisce copie
su un altro dispositivo.

## Heartbeat email

Aprire Servizi → Heartbeat email, configurare server, porta, STARTTLS o TLS,
utente, password, mittente e destinatario. Scegliere la frequenza fra 5 minuti e
7 giorni, abilitare l'invio e salvare. Il pulsante email di prova invia soltanto
su richiesta esplicita e usa la configurazione già salvata. Il timer rilegge la
configurazione a ogni esecuzione; per la frequenza dell'heartbeat non serve
riavviare il Raspberry.

Il messaggio indica se le unità HomeGate abilitate risultano attive. Una situazione
non sana è descritta come "Da verificare", senza dichiarare che tutto funziona.
Questo controllo systemd non sostituisce le prove DNS/VPN di `homegate status --check`.
Ultimo invio, ultimo tentativo ed errore SMTP sintetico restano nello stato locale.
Gli errori SMTP non registrano risposte del provider che potrebbero contenere dati
sensibili. Dopo un errore il servizio attende almeno cinque minuti prima di ritentare.

Un dispositivo spento o isolato non può inviare l'email: per notificare anche
l'assenza di heartbeat serve un monitor esterno. Il test della release usa un
trasporto simulato; la consegna reale richiede le proprie credenziali SMTP.

## Log e diagnosi degli aggiornamenti

Gli aggiornamenti registrano fase, identificativo dell'operazione, esito del
rollback e controlli falliti. L'ultimo risultato è conservato in
`/var/lib/homegate/update-result.json`. La pagina Log mostra riepilogo, gravità e
contesto, con dettagli tecnici espandibili. Anche gli errori CLI delle versioni
precedenti vengono riconosciuti quando journald li ha classificati come INFO.
I messaggi systemd mostrano l'unità interessata anziché `init.scope`.

Per un errore storico raccogliere tutti i livelli, non soltanto i messaggi finali:

```sh
sudo journalctl -u homegate-update.service --since "2026-10-08 03:55:00" --until "2026-10-08 04:15:00" --no-pager -o short-iso
```

Le date del comando si riferiscono all'orologio locale del Raspberry. Nel journal
dell'8 ottobre 2026 alle 04:07:51 l'update è terminato con
`Another HomeGate change is in progress`. Il watchdog DNS è partito alle 04:07:50
e ha completato il controllo alle 04:07:51: i due processi usano lo stesso lock.
Il fallimento precede il recupero Git e l'attivazione della release.

Dalla 0.4.1 l'updater attende fino a 60 secondi il rilascio del lock. Gli altri
comandi continuano a rifiutare immediatamente modifiche concorrenti. Se il limite
scade, l'update termina senza recuperare o attivare una release e senza bloccare
un commit candidato. Il timeout complessivo del servizio resta 300 secondi.


## Aggiornamenti delle applicazioni

Il dettaglio Servizi mostra aggiornamenti solo quando manifest locale, release
iniziale, runtime e unità rispettano lo [standard canonico](service-standard.md).
Un controllo verifica `stable`, `VERSION`, tag e contratto. L'installazione
avvia un lavoro systemd separato e riavvia soltanto l'applicazione selezionata.
La verifica richiede stato systemd `active`, PID e contatore dei riavvii stabili
per due secondi dopo l'avvio o il rollback per i runtime nativi. Per Docker
verifica invece la readiness HTTP dichiarata nel manifest; vedere
[applicazioni Docker](docker-services.md) per log, risorse, riposo, arresto e pausa.

Dalla CLI usare `sudo homegate service-update <id>` e, dopo aver risolto un
fallimento, `sudo homegate service-update <id> --retry`. Il recupero dei
collegamenti interrotti usa `sudo homegate services-recover`: arrestare prima
le unità applicative interessate e riavviarle dopo. Il comando modifica solo i
collegamenti, senza riavviare processi. Al boot l'ordine è gestito dalle dipendenze
delle unità applicative. Stato, cache e
risultato dell'update sono in `/var/lib/homegate/service-updates/<id>`; i dati
applicativi restano in `/var/lib/homegate/services/<id>`.

Le sezioni `release`, `environment` e `databases` non cambiano fra release
aggiornabili. Cambiamenti del contratto, salti di versione principale e
migrazioni dati incompatibili richiedono intervento locale. Il rollback del
codice conserva i dati presenti. Le applicazioni non hanno ancora pianificazione
notturna o personalizzata: quella del pannello Aggiornamenti riguarda HomeGate.

## Accesso GitHub

Da 0.7.2 il wizard offre **Accedi con GitHub**, tramite GitHub App e codice
di autorizzazione. Il rinnovo delle credenziali è automatico. Il token personale
resta come alternativa. Vedi [Collegare GitHub](github-connection.md).
