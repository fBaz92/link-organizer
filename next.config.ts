import type { NextConfig } from "next";

/*
 * Flow: configurazione Next.js. better-sqlite3 è un addon nativo: va escluso
 * dal bundling server di Next e richiesto a runtime (serverExternalPackages).
 * `output: "standalone"` produce il pacchetto minimale copiato nell'immagine
 * Docker del servizio HomeGate; `unoptimized` evita scritture nella cache
 * immagini (nel container il filesystem è in sola lettura tranne /data e
 * /tmp). Il limite body delle server actions segue il tetto del proxy
 * HomeGate (16 MiB): per file più grandi c'è il bot Telegram.
 */
const nextConfig: NextConfig = {
  output: "standalone",
  serverExternalPackages: ["better-sqlite3"],
  images: {
    // Anteprima YouTube di fallback, finché la copia locale non esiste.
    remotePatterns: [{ protocol: "https", hostname: "i.ytimg.com" }],
    // Container read-only: niente cache dell'ottimizzatore su disco.
    unoptimized: true,
  },
  experimental: {
    serverActions: { bodySizeLimit: "16mb" },
  },
};

export default nextConfig;
