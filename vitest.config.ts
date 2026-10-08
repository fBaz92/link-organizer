import { defineConfig } from "vitest/config";
import path from "node:path";

/*
 * Flow: configurazione Vitest. Ambiente node (il dominio non tocca il DOM);
 * i test usano l'alias "@" come l'app e un DB SQLite in-memory per i test
 * di persistenza. Nessuna credenziale: tutto ciò che serve è injected.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "tests/**/*.test.ts"],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
