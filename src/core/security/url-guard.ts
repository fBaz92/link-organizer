import { isIP } from "node:net";
import dns from "node:dns/promises";

/*
 * Flow: guardia SSRF per OGNI richiesta di rete fatta a partire da un URL
 * fornito dall'utente (bot, web, import).
 *
 * assertSafeRemoteUrl():
 *  1. accetta solo http/https;
 *  2. rifiuta host "localhost", *.localhost e IP letterali riservati;
 *  3. risolve il DNS e controlla OGNI indirizzo restituito contro le range
 *     private/riservate (loopback, RFC1918, link-local, CGNAT, Unique Local
 *     IPv6, multicast, documentation, ecc.).
 *
 * Le richieste HTTP vere e proprie (MetadataFetcher) rieseguono il check a
 * ogni hop di redirect, così un redirect verso la rete interna non passa.
 * Limite noto (accettato per un tool personale): non protegge dal DNS
 * rebinding tra check e fetch.
 */

export class UnsafeUrlError extends Error {
  constructor(reason: string) {
    super(`URL non consentito: ${reason}`);
    this.name = "UnsafeUrlError";
  }
}

const FORBIDDEN_HOSTNAMES = new Set(["localhost", "metadata.google.internal"]);

export async function assertSafeRemoteUrl(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UnsafeUrlError("non è un URL valido");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new UnsafeUrlError(`protocollo ${url.protocol} non supportato`);
  }

  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (FORBIDDEN_HOSTNAMES.has(hostname) || hostname.endsWith(".localhost")) {
    throw new UnsafeUrlError("host riservato");
  }

  if (isIP(hostname) !== 0 && isPrivateAddress(hostname)) {
    throw new UnsafeUrlError("indirizzo IP privato o riservato");
  }

  let addresses;
  try {
    addresses = await dns.lookup(hostname, { all: true });
  } catch {
    throw new UnsafeUrlError("host non risolvibile");
  }
  if (addresses.length === 0) throw new UnsafeUrlError("host non risolvibile");

  for (const { address } of addresses) {
    if (isPrivateAddress(address)) {
      throw new UnsafeUrlError("risolve su un indirizzo privato o riservato");
    }
  }

  return url;
}

export function isPrivateAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return isPrivateIPv4(address);
  if (family === 6) return isPrivateIPv6(address);
  return true; // non è un IP: trattalo come non fidato
}

function isPrivateIPv4(address: string): boolean {
  const [a, b, c] = address.split(".").map((part) => Number.parseInt(part, 10));
  if ([a, b, c].some(Number.isNaN)) return true;

  if (a === 0 || a === 10 || a === 127) return true; // this-host, privata, loopback
  if (a === 169 && b === 254) return true; // link-local
  if (a === 172 && b >= 16 && b <= 31) return true; // privata
  if (a === 192 && b === 168) return true; // privata
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a === 192 && b === 0 && c === 0) return true; // IETF protocol assignments
  if (a === 192 && b === 0 && c === 2) return true; // documentation
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a === 198 && b === 51 && c === 100) return true; // documentation
  if (a === 203 && b === 0 && c === 113) return true; // documentation
  if (a >= 224) return true; // multicast + reserved + broadcast
  return false;
}

function isPrivateIPv6(address: string): boolean {
  const normalized = address.toLowerCase();

  // IPv4-mapped (::ffff:10.0.0.1): giudica la parte IPv4.
  const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateIPv4(mapped[1]);

  if (normalized === "::" || normalized === "::1") return true; // unspecified, loopback
  if (/^f[cd]/.test(normalized)) return true; // unique local fc00::/7
  if (/^fe[89ab]/.test(normalized)) return true; // link-local fe80::/10
  if (/^ff/.test(normalized)) return true; // multicast ff00::/8
  if (normalized.startsWith("2001:db8:")) return true; // documentation
  return false;
}
