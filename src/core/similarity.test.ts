import { describe, expect, it } from "vitest";
import {
  levenshtein,
  normalizeForSearch,
  rankBySimilarity,
  scoreItem,
  tokenSimilarity,
} from "@/core/similarity";

/*
 * Flow: test della ricerca "simile". Le proprietà che contano: tolleranza
 * ai refusi, prefissi e diacritici; semantica AND tra token; taglio al
 * limite;ordinamento per punteggio.
 */

describe("normalizeForSearch", () => {
  it("rimuove diacritici, punteggiatura e maiuscole", () => {
    expect(normalizeForSearch("Perché l'Ingegneria? (parte 2)")).toBe("perche l ingegneria parte 2");
  });

  it("gestisce testi vuoti o di sola punteggiatura", () => {
    expect(normalizeForSearch("")).toBe("");
    expect(normalizeForSearch("!!! — ???")).toBe("");
  });
});

describe("tokenSimilarity", () => {
  it("parità esatta vale 1", () => {
    expect(tokenSimilarity("rust", "rust")).toBe(1);
  });

  it("prefisso vale molto (ing → ingegneria)", () => {
    expect(tokenSimilarity("ing", "ingegneria")).toBeGreaterThan(0.8);
  });

  it("substring vale intermedio (rust → rustownership)", () => {
    const score = tokenSimilarity("rust", "rustownership");
    expect(score).toBeGreaterThan(0.5);
    expect(score).toBeLessThan(1);
  });

  it("refusi tollerati via Levenshtein (rustt → rust)", () => {
    expect(tokenSimilarity("rustt", "rust")).toBeGreaterThan(0.6);
  });

  it("token senza relazione valgono 0", () => {
    expect(tokenSimilarity("gatto", "idraulico")).toBe(0);
  });

  it("token corti: solo parità o prefisso", () => {
    expect(tokenSimilarity("db", "db")).toBe(1);
    expect(tokenSimilarity("db", "dbms")).toBe(0.9);
    expect(tokenSimilarity("db", "adbjk")).toBe(0);
  });
});

describe("levenshtein", () => {
  it("distanze note", () => {
    expect(levenshtein("kitten", "sitting")).toBe(3);
    expect(levenshtein("", "abc")).toBe(3);
    expect(levenshtein("abc", "abc")).toBe(0);
  });
});

describe("scoreItem", () => {
  const fields = { title: "Grid-forming inverters: a deep dive", channel: "Power Systems Weekly" };

  it("match pieno sul titolo punteggia alto", () => {
    expect(scoreItem("grid forming inverters", fields)).toBeGreaterThan(0.8);
  });

  it("refusi sul titolo restano sopra soglia", () => {
    expect(scoreItem("grid formng invertrs", fields)).toBeGreaterThan(0.5);
  });

  it("match sul canale vale, ma meno del titolo", () => {
    const onChannel = scoreItem("power systems weekly", fields);
    const onTitle = scoreItem("grid forming inverters", fields);
    expect(onChannel).toBeGreaterThan(0.5);
    expect(onChannel).toBeLessThan(onTitle);
  });

  it("semantica AND: un token senza corrispondenza scarta l'item", () => {
    expect(scoreItem("grid formichiere", fields)).toBe(0);
  });

  it("diacritici non cambiano il punteggio", () => {
    expect(scoreItem("sistemi elettrici", { title: "Sistemi elettrici di potenza" })).toBe(
      scoreItem("sistemi elettrici", { title: "Sistemi elettrici di potenza" }),
    );
  });

  it("bonus frase quando la query intera è nel campo", () => {
    // Match sul canale (0.85): senza clamp a 1 si vede il bonus frase.
    const withPhrase = scoreItem("deep dive", { title: "Power electronics", channel: "deep dive academy" });
    const withoutPhrase = scoreItem("deep dive", { title: "Power electronics", channel: "academy dive deep" });
    expect(withoutPhrase).toBeGreaterThan(0.8);
    expect(withPhrase).toBeGreaterThan(withoutPhrase);
  });

  it("query vuota vale 0", () => {
    expect(scoreItem("   ", fields)).toBe(0);
  });
});

describe("rankBySimilarity", () => {
  const items = [
    { id: 1, title: "Rust ownership explained", channel: "Rustaceans" },
    { id: 2, title: "Introduzione a Rust", channel: "Programmazione IT" },
    { id: 3, title: "Cooking pasta at home", channel: "Chef TV" },
    { id: 5, title: "Ownership model in Rust", channel: "Core Rust" },
  ];

  it("semantica AND: serve ogni token della query da qualche parte", () => {
    // "ownership" manca in 2 e 3 → restano solo 1 e 5.
    expect(rankBySimilarity(items, "rust ownership", (i) => i).map((r) => r.item.id).sort()).toEqual([1, 5]);
  });

  it("il match sul titolo batte il match sul canale nell'ordinamento", () => {
    const mixed = [
      { id: 7, title: "Programmazione avanzata", channel: "Corso Rust" },
      { id: 6, title: "Corso di Rust completo", channel: "Academy" },
    ];
    const ranked = rankBySimilarity(mixed, "cors rust", (i) => i);
    expect(ranked.map((r) => r.item.id)).toEqual([6, 7]);
    expect(ranked[0]!.score).toBeGreaterThan(ranked[1]!.score);
  });

  it("i refusi trovano comunque (ownrship → ownership)", () => {
    expect(rankBySimilarity(items, "ownrship", (i) => i).map((r) => r.item.id).sort()).toEqual([1, 5]);
  });

  it("rispetta il limite", () => {
    const many = Array.from({ length: 50 }, (_, i) => ({ id: i, title: `tutorial rust n${i}`, channel: "c" }));
    expect(rankBySimilarity(many, "tutorial rust", (i) => i).length).toBe(30);
  });

  it("cerca anche per canale", () => {
    const ranked = rankBySimilarity(items, "rustaceans", (i) => i);
    expect(ranked.map((r) => r.item.id)).toContain(1);
    expect(ranked.every((r) => r.item.id !== 3)).toBe(true);
  });
});
