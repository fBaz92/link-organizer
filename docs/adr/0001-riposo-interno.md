# 0001. Un'unica installazione con riposo interno

Stato: accettata. Data: 9 ottobre 2026.

## Vincoli

L'utente richiede una sola installazione da GitHub con Telegram sempre attivo. Il profilo HomeGate supporta un solo container e ne arresta tutti i processi durante il riposo. Il socket Docker e privilegi host non sono ammessi. I campi di distribuzione devono restare identici per aggiornare le installazioni 2.1.0.

## Decisione

Un modulo HTTP leggero supervisiona Next, che riposa dopo inattività. Telegram e l'archivio restano nel worker sempre attivo; il worker possiede anche i job video richiesti dal browser. Il seam dei job ha due adapter reali: chiamata locale in sviluppo e richiesta privata su loopback nel container. L'interface nasconde al browser dove vive il job e mantiene locality del lavoro nel worker.

L'adapter HomeGate mantiene una richiesta SSE attraverso il proxy, usando il contratto ufficiale che impedisce il riposo con richieste in corso. Questo conserva una sola installazione senza modifiche al gateway. Fuori da HomeGate non viene aperta alcuna connessione al proxy.

## Alternative e conseguenze

Separare il bot in un altro container richiederebbe un'altra installazione o una modifica all'orchestrazione di HomeGate. Un webhook esterno richiederebbe HTTPS pubblico. Entrambe aggiungerebbero configurazione per l'utente.

Il container non raggiunge consumo zero: resta la memoria del worker e del modulo HTTP. Next libera invece la propria memoria durante il riposo. La connessione SSE occupa uno slot del proxy; un suo fallimento è visibile nella diagnostica e comporta il rischio di riposo completo HomeGate. Arresto manuale e pausa continuano a fermare anche Telegram. I job sopravvivono al riposo web, non al riavvio completo del worker.
