# Collegare GitHub a HomeGate

Da HomeGate 0.7.2, apri **Servizi → Aggiungi servizio → Accedi con GitHub**.
L'accesso usa il Device Flow di una GitHub App. Funziona in LAN e tramite VPN:
HomeGate contatta GitHub in uscita e non richiede un dominio pubblico, webhook,
callback raggiungibili da Internet o porte aperte sul router.

## Primo collegamento

1. Premi **Scegli le repository accessibili a HomeGate**.
2. Su GitHub installa l'app nel tuo account. Scegli **Only select repositories**
   e seleziona le repository dei servizi. I permessi sono **Contents: Read** e
   **Metadata: Read**. Non sono richiesti permessi di scrittura.
3. Torna nella dashboard e premi **Accedi con GitHub**.
4. Apri il link di autorizzazione e inserisci il codice mostrato da HomeGate.
5. Conferma su GitHub. HomeGate passa automaticamente alla scelta della repository.

Il codice dura al massimo 15 minuti. Puoi annullarlo e generarne uno nuovo.
Se chiudi la pagina prima di autorizzare, ripeti il collegamento. Non condividere
il codice: autorizza soltanto quello generato nella tua dashboard.

Per aggiungere altre repository, modifica l'installazione dell'app su GitHub.
La compatibilità di un servizio continua a dipendere dal suo `service.toml`,
dallo standard dei servizi e dalla release `stable`; l'accesso GitHub non rende
compatibile una repository priva del contratto richiesto.

## Credenziali e rinnovo

Access token e refresh token restano sul dispositivo, in file di proprietà del
gestore con permessi `0600`, accanto a `/etc/homegate/github-token`. Non sono
restituiti alle API della dashboard, inclusi nei log o passati come argomenti ai
comandi Git. Il device code resta solo nella memoria del processo della dashboard.
Ogni tentativo è legato alla sessione che lo ha iniziato.

I token dell'app scadono e vengono rinnovati automaticamente prima delle chiamate
API e della preparazione dei download Git. Il rinnovo usa il Device Flow e non
richiede un client secret o una chiave privata nel Raspberry. Se l'accesso viene
revocato o il refresh token scade, HomeGate chiede di ricollegare GitHub.

**Scollega GitHub** elimina le credenziali locali. Per revocare anche l'accesso
su GitHub, disinstalla o revoca l'app nelle impostazioni del tuo account.
Il token personale di sola lettura resta disponibile sotto **Usa un token
personale**, per installazioni che preferiscono quel metodo.

## Usare un'altra GitHub App

L'app inclusa, `HomeGate-fBaz92`, è privata all'account fBaz92. Per altri account
registra una propria GitHub App, abilita **Enable Device Flow** e lascia abilitata
la scadenza dei token. Richiedi soltanto Contents e Metadata in lettura, disabilita
i webhook. Installa l'app sulle repository scelte.

Sul dispositivo crea `/etc/homegate/github-app.toml` con i due identificativi
pubblici della propria app:

```toml
client_id = "Iv23liIL_TUO_CLIENT_ID"
slug = "nome-della-tua-app"
```

Il file locale prevale su quello incluso nella release. Non inserire client
secret, token o chiavi private in questo file. Non occorre modificare i manifest,
i `.env`, i database o i workflow dei servizi per cambiare modalità di accesso.

Riferimenti: [Device Flow](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app)
e [rinnovo dei token](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/refreshing-user-access-tokens).
