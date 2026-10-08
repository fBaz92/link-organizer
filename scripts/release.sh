#!/usr/bin/env bash
#
# Rilascio del servizio HomeGate (contratto: VERSION + service.toml + tag
# vX.Y.Z + canale `stable` sullo stesso commit). Esegue prima tutte le
# verifiche e rifiuta di pubblicare se il bundle committato non è aggiornato.
#
# Uso: bash scripts/release.sh            # verifica e mostra i comandi
#      bash scripts/release.sh 1.0.0      # tagga v1.0.0 e pubblica (con --yes)

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${REPO_ROOT}"

say() { printf '\n▶ %s\n' "$1"; }
die() { echo "ERRORE: $1" >&2; exit 1; }

VERSION_ARG="${1:-}"

say "Albero pulito"
[ -z "$(git status --porcelain)" ] || die "albero non pulito: committare prima di rilasciare"

say "Typecheck + test"
pnpm typecheck
pnpm test

say "Bundle del servizio"
pnpm build:service

say "Bundle committato aggiornato"
git diff --exit-code dist/main.js || die "dist/main.js ricostruito differisce dal commit: ricompilare e committare"

say "Prova del pacchetto estratto"
bash scripts/package-check.sh

say "Dimensione dell'archivio (limite HomeGate: 20 MiB)"
ARCHIVE_SIZE="$(git archive --format=tar HEAD | wc -c | tr -d ' ')"
LIMIT=$((20 * 1024 * 1024))
echo "archivio: ${ARCHIVE_SIZE} byte (limite ${LIMIT})"
[ "${ARCHIVE_SIZE}" -le "${LIMIT}" ] || die "archivio oltre i 20 MiB"

VERSION="$(tr -d '[:space:]' < VERSION)"
echo "VERSION: ${VERSION}"

if [ -z "${VERSION_ARG}" ] || [ "${VERSION_ARG}" != "${VERSION}" ]; then
  cat <<EOF

Tutto verificato. Per pubblicare la release ${VERSION}:
  git tag v${VERSION} && git push origin v${VERSION}
  git push origin HEAD:refs/heads/stable
oppure rilancia: bash scripts/release.sh ${VERSION} --yes
EOF
  exit 0
fi

[ "${2:-}" = "--yes" ] || die "passa --yes per pubblicare davvero: bash scripts/release.sh ${VERSION} --yes"

say "Tag v${VERSION}"
git rev-parse -q --verify "refs/tags/v${VERSION}" >/dev/null && die "tag v${VERSION} già esistente"
git tag "v${VERSION}"
git push origin "v${VERSION}"

say "Canale stable → stesso commit del tag"
SHA="$(git rev-parse HEAD)"
git push origin "${SHA}:refs/heads/stable"

echo "Release v${VERSION} pubblicata: tag v${VERSION} e stable → ${SHA}"
