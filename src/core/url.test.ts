import { describe, expect, it } from "vitest";
import { normalizeUrl, urlHash, youtubeVideoId } from "@/core/url";

/*
 * Flow: test del normalizzatore URL. Il contratto chiave: rappresentazioni
 * diverse della stessa risorsa → stessa forma canonica → stesso hash.
 */
describe("normalizeUrl", () => {
  it("normalizza host, www, fragment e slash finali", () => {
    expect(normalizeUrl("HTTPS://www.Esempio.it/percorso/#sez")).toBe("https://esempio.it/percorso");
    expect(normalizeUrl("https://esempio.it")).toBe("https://esempio.it");
    expect(normalizeUrl("https://esempio.it/")).toBe("https://esempio.it");
  });

  it("aggiunge lo schema ai domini nudi", () => {
    expect(normalizeUrl("esempio.it/percorso")).toBe("https://esempio.it/percorso");
  });

  it("rimuove i parametri di tracking e ordina i restanti", () => {
    const url = normalizeUrl("https://esempio.it/a?utm_source=x&b=2&a=1&fbclid=abc");
    expect(url).toBe("https://esempio.it/a?a=1&b=2");
  });

  it("riduce le forme YouTube alla stessa identità", () => {
    const forms = [
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ&feature=share",
      "https://youtube.com/watch?v=dQw4w9WgXcQ&t=42s",
      "https://youtu.be/dQw4w9WgXcQ?si=abc",
      "https://www.youtube.com/shorts/dQw4w9WgXcQ",
      "https://www.youtube.com/embed/dQw4w9WgXcQ",
      "https://m.youtube.com/watch?v=dQw4w9WgXcQ",
    ];
    const canonicals = forms.map((f) => normalizeUrl(f));
    expect(new Set(canonicals).size).toBe(1);
    expect(canonicals[0]).toBe("https://youtu.be/dQw4w9WgXcQ");
  });

  it("preserva le playlist YouTube senza video", () => {
    expect(normalizeUrl("https://www.youtube.com/playlist?list=PL123&si=x")).toBe(
      "https://www.youtube.com/playlist?list=PL123",
    );
  });

  it("canonicalizza Spotify e X/Twitter", () => {
    expect(normalizeUrl("https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC?si=x")).toBe(
      "https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC",
    );
    expect(normalizeUrl("https://twitter.com/user/status/1234567890123456789")).toBe(
      "https://x.com/user/status/1234567890123456789",
    );
  });

  it("rifiuta ciò che non è un URL http(s)", () => {
    expect(normalizeUrl("non è un url")).toBeNull();
    expect(normalizeUrl("ftp://esempio.it/file")).toBeNull();
    expect(normalizeUrl("")).toBeNull();
  });
});

describe("urlHash", () => {
  it("due forme dello stesso video → stesso hash", () => {
    const a = urlHash(normalizeUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ")!);
    const b = urlHash(normalizeUrl("https://youtu.be/dQw4w9WgXcQ?si=xyz")!);
    expect(a).toBe(b);
  });

  it("URL diversi → hash diversi", () => {
    const a = urlHash(normalizeUrl("https://esempio.it/a")!);
    const b = urlHash(normalizeUrl("https://esempio.it/b")!);
    expect(a).not.toBe(b);
  });
});

describe("youtubeVideoId", () => {
  it("estrae l'ID da tutte le forme note", () => {
    const urls = [
      "https://youtu.be/dQw4w9WgXcQ",
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      "https://www.youtube.com/shorts/dQw4w9WgXcQ",
      "https://www.youtube.com/live/dQw4w9WgXcQ",
    ].map((u) => new URL(u));
    expect(urls.map((u) => youtubeVideoId(u))).toEqual(
      urls.map(() => "dQw4w9WgXcQ"),
    );
  });
});
