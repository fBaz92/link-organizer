#!/usr/bin/env bash
#
# Prova del container Docker come lo esegue HomeGate (profilo docker-services):
# - filesystem in sola lettura con /tmp e /run come tmpfs e /data come volume;
# - UID/GID non root arbitrari (nessun utente nominato);
# - health check pubblico su /health, login richiesto sulle pagine;
# - arresto con SIGTERM (docker stop) e attesa di exit 0;
# - il bot senza token non abbatte il container (worker secondario).
#
# Uso: bash scripts/docker-check.sh              # build locale + prova
#      bash scripts/docker-check.sh <immagine>   # prova un'immagine esistente

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE="${1:-stash-check:local}"
CID=""

cleanup() {
  [ -n "${CID}" ] && docker rm -f "${CID}" >/dev/null 2>&1 || true
}
trap cleanup EXIT

fail() {
  echo "FAIL: $1" >&2
  [ -n "${CID}" ] && (docker logs "${CID}" 2>&1 | tail -40 >&2 || true)
  exit 1
}

if [ $# -eq 0 ]; then
  echo "▶ Build dell'immagine locale (architettura corrente)"
  docker build -t "${IMAGE}" "${REPO_ROOT}" >/dev/null || fail "build fallito"
fi

echo "▶ yt-dlp e ffmpeg presenti nell'immagine"
docker run --rm --entrypoint sh "${IMAGE}" -c 'yt-dlp --version >/dev/null && ffmpeg -version >/dev/null' \
  || fail "strumenti video mancanti nell'immagine"

echo "▶ bot compilato nell'immagine: comandi, polling e risposta Telegram simulata"
docker run --rm --read-only --tmpfs /tmp:rw,size=64m --user 65534:65534 \
  --entrypoint node -e STASH_BUNDLE_PATH=/app/service/main.js \
  -v "${REPO_ROOT}/scripts/telegram-check.mjs:/tmp/telegram-check.mjs:ro" \
  "${IMAGE}" /tmp/telegram-check.mjs || fail "bot compilato non funzionante"

echo "▶ Avvio con vincoli HomeGate (read-only, tmpfs, UID 65534)"
DATA_DIR="$(mktemp -d "${TMPDIR:-/tmp}/stash-docker-data.XXXXXX")"
# HomeGate prepara /data scrivibile per l'UID assegnato: nel test si replica
# aprendo la cartella (mktemp nasce 0700 dell'utente che lo crea).
chmod 0777 "${DATA_DIR}"
# Password di prova generata a caso: nessuna credenziale nel sorgente.
CHECK_PASSWORD="$(head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n')"
CID="$(docker run -d \
  --read-only \
  --tmpfs /tmp:rw,size=64m \
  --tmpfs /run:rw,size=16m \
  -v "${DATA_DIR}:/data" \
  --user 65534:65534 \
  -e BOT_TOKEN= \
  -e TELEGRAM_ALLOWED_USER_IDS= \
  -e WEB_PASSWORD="${CHECK_PASSWORD}" \
  -e HOMEGATE_STATE_DIR=/data \
  -e HOMEGATE_CONFIG_DIR=/config \
  -e PORT=3000 \
  -e STASH_WEB_IDLE_SECONDS=2 \
  -p 127.0.0.1::3000 \
  "${IMAGE}")"
[ -n "${CID}" ] || fail "container non partito"

HOST_PORT="$(docker port "${CID}" 3000/tcp | head -1 | sed 's/.*://')"
[ -n "${HOST_PORT}" ] || fail "porta non pubblicata"
BASE="http://127.0.0.1:${HOST_PORT}"

# Attende la readiness HTTP (health_path del manifest), max 90 s.
ready=""
for _ in $(seq 1 90); do
  CODE="$(curl -s -o /dev/null -w '%{http_code}' "${BASE}/health" || true)"
  if [ "${CODE}" = "200" ]; then ready=1; break; fi
  docker inspect -f '{{.State.Running}}' "${CID}" | grep -q true || fail "container morto durante l'avvio"
  sleep 1
done
[ -n "${ready}" ] || fail "/health non pronto entro 90 s"

echo "▶ /health 200 (pubblico) e corpo JSON"
curl -s "${BASE}/health" | grep -q '"status":"ok"' || fail "/health non risponde con stato ok"

echo "▶ pagine protette: / redirige al login, /login raggiungibile"
CODE="$(curl -s -o /dev/null -w '%{http_code}' "${BASE}/")"
[ "${CODE}" = "307" ] || [ "${CODE}" = "302" ] || fail "/ non redirige al login (HTTP ${CODE})"
curl -sf -o /dev/null "${BASE}/login" || fail "/login non raggiungibile"

echo "▶ pagine autenticate dell'archivio attraversano il proxy"
SESSION_COOKIE="$(docker exec "${CID}" node -e 'const c=require("node:crypto");const e=Math.floor(Date.now()/1000)+300;console.log(e+"."+c.createHmac("sha256",process.env.WEB_PASSWORD).update("stash:"+e).digest("hex"))')"
for PAGE in / /tags /lucky /aiuto /scarica; do
  CODE="$(curl --max-time 60 -s -o /dev/null -w '%{http_code}' -b "stash_session=${SESSION_COOKIE}" "${BASE}${PAGE}")"
  [ "${CODE}" = "200" ] || fail "pagina autenticata ${PAGE} non disponibile (HTTP ${CODE})"
done

echo "▶ SSE keepalive risponde 401 senza sessione"
CODE="$(curl -s -o /dev/null -w '%{http_code}' "${BASE}/api/keepalive")"
[ "${CODE}" = "401" ] || fail "keepalive senza sessione atteso 401, avuto ${CODE}"

echo "▶ database creato in /data (non nel filesystem immagine)"
[ -f "${DATA_DIR}/stash.db" ] || fail "stash.db non creato nella cartella dati"

echo "▶ worker bot assente non abbatte il container"
sleep 2
docker inspect -f '{{.State.Running}}' "${CID}" | grep -q true || fail "container fermo nonostante il bot sia solo disabilitato"
docker logs "${CID}" 2>&1 | grep -q '"event":"viewer_disabled"\|"event":"bot_config_missing"' \
  || fail "manca il log della modalità bot"

echo "▶ /health resta disponibile mentre Next dorme"
wait_sleeping() {
  for _ in $(seq 1 30); do
    HEALTH="$(curl -sf "${BASE}/health" || true)"
    if echo "${HEALTH}" | grep -q '"web":{"state":"sleeping"'; then return 0; fi
    sleep 1
  done
  fail "Next non va in riposo dopo inattività: ${HEALTH}"
}
wait_sleeping

echo "▶ la prima richiesta POST risveglia Next e raggiunge la webapp"
# La risposta di Next su una rotta protetta dimostra il passaggio attraverso
# il proxy anche per una richiesta con corpo inviata mentre Next dorme.
CODE="$(curl --max-time 60 -s -o /dev/null -w '%{http_code}' -X POST \
  -H 'Content-Type: application/json' --data '{"wake":"check"}' "${BASE}/api/nonexistent")"
[ "${CODE}" = "401" ] || [ "${CODE}" = "404" ] || [ "${CODE}" = "405" ] \
  || fail "POST dopo riposo non inoltrato (HTTP ${CODE})"
curl --max-time 60 -sf -o /dev/null "${BASE}/login" || fail "/login non disponibile dopo risveglio"
wait_sleeping

echo "▶ Arresto ordinato: SIGTERM → exit 0"
docker stop -t 10 "${CID}" >/dev/null
EXIT_CODE="$(docker inspect -f '{{.State.ExitCode}}' "${CID}")"
[ "${EXIT_CODE}" = "0" ] || fail "exit code ${EXIT_CODE} dopo docker stop"
docker logs "${CID}" 2>&1 | grep -q '"event":"container_stopped"' || fail "manca l'evento container_stopped"

echo "PASS: container verificato (read-only, UID non root, /health, auth, riposo/risveglio, SIGTERM→exit 0)"
