# Contratto delle release applicative

Per creare o adattare una repo usare lo [standard canonico delle applicazioni](service-standard.md).
Quel documento sostituisce la precedente bozza del contratto e contiene il
manifest completo, gli esempi Node/Python/binary/Docker, l'enrollment locale e le unità
systemd compatibili con il gestore attuale.

Il contratto implementato usa `schema = 1`, `id`, `description` leggibile per le nuove repo da HomeGate 0.7.1 e la sezione `release` con
`repository`, `runtime`, `entrypoint`, `architectures`, `os` e `runtime_min`
facoltativo. Le sezioni `environment` e `databases` descrivono il contratto di
gestione. Durante gli aggiornamenti queste tre sezioni devono corrispondere al
manifest locale fidato.

La distribuzione usa il commit Git di `stable`, il cui `VERSION` deve coincidere
con il tag `vX.Y.Z`. Sono supportati Python, Node e binari per Linux con runtime
provisionato sull'host; HomeGate non esegue build hook o installatori npm/pip.
Il wizard Aggiungi servizio esegue la prima installazione; il provisioning manuale resta disponibile. Il controllo applicativo verifica soltanto lo
stato systemd `active`, PID e contatore dei riavvii stabili per due secondi,
senza verificare readiness HTTP per i processi nativi. Il profilo Docker richiede
HomeGate 0.8.0, Docker Engine 28+ e una readiness HTTP esplicita. Vedi
[applicazioni Docker](docker-services.md): il digest può cambiare tra release,
mentre gli altri campi `container` restano invariati. Il rollback ripristina
codice e immagine e conserva i dati.

Le sezioni della vecchia bozza `platforms`, `runtime`, `process`, `health` e
`data`, la sostituzione di placeholder e gli asset tar.gz delle GitHub Release
non sono un formato di deploy supportato. Convertire le repo preparate sulla
bozza seguendo lo standard canonico prima di registrarle per gli aggiornamenti.

Per uso della dashboard, `.env`, segreti e SQLite consultare la
[gestione delle applicazioni](service-management.md).
