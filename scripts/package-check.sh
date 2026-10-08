#!/usr/bin/env bash
#
# Prova del pacchetto del servizio come lo esegue HomeGate: estrae il bundle
# in una directory diversa dalla build, lo avvia con node (niente node_modules
# né strumenti di sviluppo), verifica il log JSON strutturato e una risposta
# HTTP, poi arresta con SIGTERM e pretende exit 0 e nessuna scrittura dentro
# la release estratta.
#
# Uso: bash scripts/package-check.sh   (richiede dist/main.js: pnpm build:service)

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUNDLE="${REPO_ROOT}/dist/main.js"
VERSION_FILE="${REPO_ROOT}/VERSION"

if [[ ! -f "${BUNDLE}" ]]; then
  echo "dist/main.js mancante: eseguire prima pnpm build:service" >&2
  exit 1
fi

STAGING="$(mktemp -d "${TMPDIR:-/tmp}/stash-pkg-release.XXXXXX")"
RUNDIR="$(mktemp -d "${TMPDIR:-/tmp}/stash-pkg-run.XXXXXX")"
STATE_DIR="${RUNDIR}/state"
CONFIG_DIR="${RUNDIR}/config"
mkdir -p "${STATE_DIR}" "${CONFIG_DIR}"

cleanup() {
  [[ -n "${CHILD_PID:-}" ]] && kill -9 "${CHILD_PID}" 2>/dev/null || true
  rm -rf "${STAGING}" "${RUNDIR}"
}
trap cleanup EXIT

# Layout identico a una release HomeGate: dist/main.js + VERSION alla radice.
mkdir -p "${STAGING}/dist"
cp "${BUNDLE}" "${STAGING}/dist/main.js"
cp "${VERSION_FILE}" "${STAGING}/VERSION"
chmod +w "${STAGING}/dist/main.js"

# Porta libera: chiede a node un socket effimero e lo chiude subito.
PORT="$(node -e 'const n=require("node:net");const s=n.createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close();});')"

cd "${RUNDIR}"
env -i PATH="${PATH}" HOME="${HOME:-/tmp}" \
  HOMEGATE_STATE_DIR="${STATE_DIR}" HOMEGATE_CONFIG_DIR="${CONFIG_DIR}" \
  PORT="${PORT}" \
  node "${STAGING}/dist/main.js" >"${RUNDIR}/out.log" 2>"${RUNDIR}/err.log" &
CHILD_PID=$!

fail() {
  echo "FAIL: $1" >&2
  echo "--- stdout ---"; cat "${RUNDIR}/out.log" >&2 || true
  echo "--- stderr ---"; cat "${RUNDIR}/err.log" >&2 || true
  exit 1
}

# I warn del logger vanno su stderr: gli eventi si cercano su entrambi i flussi.
any_log() { grep -q "$1" "${RUNDIR}/out.log" "${RUNDIR}/err.log" 2>/dev/null; }

# Attende il log di avvio (max 15s).
for _ in $(seq 1 75); do
  any_log '"event":"web_listening"' && break
  if ! kill -0 "${CHILD_PID}" 2>/dev/null; then
    fail "il processo è terminato prima di ascoltare"
  fi
  sleep 0.2
done
any_log '"event":"web_listening"' || fail "web_listening non arrivato"
any_log '"event":"db_ready"' || fail "db_ready non arrivato"
any_log '"event":"bot_disabled"' || fail "bot_disabled non arrivato"

# Il database deve nascere nella cartella dati, non nella release.
[[ -f "${STATE_DIR}/stash.db" ]] || fail "stash.db non creato nella cartella dati"

# HTTP senza password configurata.
HTTP_CODE="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${PORT}/" || true)"
[[ "${HTTP_CODE}" == "200" ]] || fail "HTTP / risponde ${HTTP_CODE}"

# Snapshot della release: dopo l'arresto non deve esserci nulla di nuovo.
BEFORE="$(cd "${STAGING}" && find . -type f | sort)"

# Arresto ordinato: SIGTERM → exit 0.
kill -TERM "${CHILD_PID}"
set +e
wait "${CHILD_PID}"
EXIT_CODE=$?
set -e
[[ "${EXIT_CODE}" == "0" ]] || fail "exit code ${EXIT_CODE} dopo SIGTERM"

any_log '"event":"service_stopping"' || fail "service_stopping mancante"
any_log '"event":"service_stopped"' || fail "service_stopped mancante"

AFTER="$(cd "${STAGING}" && find . -type f | sort)"
[[ "${BEFORE}" == "${AFTER}" ]] || fail "la release è stata modificata durante l'esecuzione"

# Ogni riga JSON del ciclo di vita su stdout è su una sola riga (stderr può
# contenere anche avvisi di Node in testo libero: ammessi dal contratto).
while IFS= read -r line; do
  [[ -z "${line}" ]] && continue
  node -e 'JSON.parse(process.argv[1])' "${line}" 2>/dev/null || fail "riga di stdout non JSON: ${line}"
done <"${RUNDIR}/out.log"

echo "PASS: pacchetto verificato (avvio, HTTP, SIGTERM→exit 0, release intatta, log JSON)"
