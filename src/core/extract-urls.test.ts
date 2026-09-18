import { describe, expect, it } from "vitest";
import { extractFromEntities, extractUrls } from "@/core/extract-urls";

/*
 * Flow: test dell'estrazione URL da testo libero e dalle entity Telegram.
 */
describe("extractUrls", () => {
  it("estrae http(s) e domini nudi, senza duplicati", () => {
    const urls = extractUrls("Guarda https://youtu.be/abc123 e anche youtube.com/watch?v=xy, bello!");
    expect(urls).toContain("https://youtu.be/abc123");
    expect(urls).toContain("https://youtube.com/watch?v=xy");
  });

  it("scarta frasi che sembrano domini ma non hanno TLD plausibile", () => {
    expect(extractUrls("il file si chiama bozza.png e basta")).toEqual([]);
  });

  it("non cattura la punteggiatura finale", () => {
    expect(extractUrls("Vedi https://esempio.it.")).toEqual(["https://esempio.it"]);
  });
});

describe("extractFromEntities", () => {
  it("usa text_link e url delle entity Telegram", () => {
    const text = "clicca qui e https://esempio.it";
    const urls = extractFromEntities(text, [
      { type: "text_link", url: "https://link-nascosto.it", offset: 0, length: 10 },
      { type: "url", offset: 13, length: 18 },
    ]);
    expect(urls).toEqual(["https://link-nascosto.it", "https://esempio.it"]);
  });
});
