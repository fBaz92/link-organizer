#!/usr/bin/env bash
#
# Scrive il digest immutabile dell'immagine Docker nel [container] di
# service.toml (il contratto HomeGate rifiuta i tag mobili).
#
# Uso: bash scripts/set-image-digest.sh sha256:<64 cifre esadecimali>

set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

DIGEST="${1:?uso: set-image-digest.sh sha256:<64 hex>}"
if [[ ! "${DIGEST}" =~ ^sha256:[0-9a-f]{64}$ ]]; then
  echo "digest non valido: ${DIGEST}" >&2
  exit 1
fi

perl -pi -e "s{^image = \"[^\"]+\"$}{image = \"ghcr.io/fbaz92/link-organizer\@${DIGEST}\"}" service.toml

grep -q "^image = \"ghcr.io/fbaz92/link-organizer@${DIGEST}\"" service.toml || {
  echo "sostituzione del digest fallita" >&2
  exit 1
}
echo "service.toml → image = ghcr.io/fbaz92/link-organizer@${DIGEST}"
