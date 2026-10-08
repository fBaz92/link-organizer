# syntax=docker/dockerfile:1
#
# Immagine del servizio HomeGate (profilo Docker, contratto docker-services):
# - un solo processo web in foreground (la webapp Next completa) più il bot
#   Telegram come worker nello stesso container (niente compose);
# - avvio con UID/GID non root assegnati da HomeGate: nessuno USER nominato;
# - filesystem in sola lettura tranne /data (mount HomeGate), /tmp e /run:
#   la cache di Next è un symlink verso /tmp/next-cache;
# - SIGTERM gestito dal supervisor entro 10 secondi (docker/entrypoint.mjs).

FROM node:22-bookworm-slim AS builder
WORKDIR /build
ENV NEXT_TELEMETRY_DISABLED=1
RUN corepack enable
# Solo i manifest: lo strato delle dipendenze resta cachato fra build.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build && pnpm build:service

FROM node:22-bookworm-slim AS runner
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    TMPDIR=/tmp \
    STASH_VIEWER=0 \
    PORT=3000
# yt-dlp (download video + metadati completi YouTube) e ffmpeg (720p,
# spezzettamento parti). Entrambi multi-architetture via apt/pip.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates ffmpeg python3 python3-pip \
 && pip3 install --no-cache-dir --break-system-packages yt-dlp \
 && apt-get purge -y python3-pip \
 && apt-get autoremove -y \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=builder /build/.next/standalone ./web
COPY --from=builder /build/.next/static ./web/.next/static
COPY --from=builder /build/public ./web/public
COPY --from=builder /build/dist/main.js ./service/main.js
COPY --from=builder /build/VERSION ./VERSION
COPY docker/entrypoint.mjs ./entrypoint.mjs

# Cache di Next (fetch/ottimizzazioni) su spazio scrivibile: il rootfs del
# container è in sola lettura. /data è il mount persistente di HomeGate.
RUN mkdir -p /tmp/next-cache /data \
 && ln -s /tmp/next-cache ./web/.next/cache \
 && chmod -R a+rX /app

EXPOSE 3000
ENTRYPOINT ["node", "/app/entrypoint.mjs"]
