import type { NextConfig } from "next";

/*
 * Flow: configurazione Next.js. better-sqlite3 è un addon nativo: va escluso
 * dal bundling server di Next e richiesto a runtime (serverExternalPackages).
 */
const nextConfig: NextConfig = {
  serverExternalPackages: ["better-sqlite3"],
  images: {
    // Anteprima YouTube di fallback, finché la copia locale non esiste.
    remotePatterns: [{ protocol: "https", hostname: "i.ytimg.com" }],
  },
  experimental: {
    // Gli upload dei documenti passano dalle server actions.
    serverActions: { bodySizeLimit: "100mb" },
  },
};

export default nextConfig;
