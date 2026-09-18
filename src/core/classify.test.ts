import { describe, expect, it } from "vitest";
import { classifyFile, classifyUrl, keywordTags } from "@/core/classify";

/*
 * Flow: test del classificatore regex. Il contratto: tipo deciso dalla prima
 * regola di dominio che combacia, tag cumulativi, testo (titolo/descrizione)
 * solo arricchente, file = documento con tag di formato.
 */
describe("classifyUrl", () => {
  it("riconosce i video YouTube", () => {
    const result = classifyUrl("https://youtu.be/dQw4w9WgXcQ");
    expect(result.type).toBe("video");
    expect(result.tags).toContain("video");
  });

  it("distingue podcast e musica su Spotify dal path", () => {
    expect(classifyUrl("https://open.spotify.com/episode/3aa2QuAJ8jUUmCAiDQOqfu").type).toBe("podcast");
    expect(classifyUrl("https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC").type).toBe("musica");
  });

  it("riconosce repo, paper e post social", () => {
    expect(classifyUrl("https://github.com/vercel/next.js").type).toBe("repo");
    expect(classifyUrl("https://arxiv.org/abs/2401.00001").type).toBe("paper");
    expect(classifyUrl("https://x.com/user/status/1234567890123456789").type).toBe("post");
  });

  it("i sottodomini ereditano la regola del dominio", () => {
    expect(classifyUrl("https://music.youtube.com/watch?v=x").tags).toContain("video");
  });

  it("le keyword del titolo aggiungono tag senza cambiare tipo", () => {
    const result = classifyUrl("https://esempio.it/video-x", "Un grande tutorial di cucina");
    expect(result.type).toBe("link");
    expect(result.tags).toContain("guide");
  });

  it("le keyword tematiche arrivano anche dalla descrizione", () => {
    const result = classifyUrl(
      "https://esempio.it/video-y",
      "Introduzione ai power systems: transformers, transmission lines and load flow",
    );
    expect(result.type).toBe("link");
    expect(result.tags).toContain("power-systems");
  });

  it("fallback onesto per domini sconosciuti", () => {
    expect(classifyUrl("https://sito-strano.example/pagina")).toEqual({ type: "link", tags: [] });
  });
});

describe("keywordTags", () => {
  it("riconosce i domini tematici da titolo e descrizione", () => {
    expect(keywordTags("Fault analysis in power systems")).toContain("power-systems");
    expect(keywordTags("Buck converter design: power electronics basics")).toContain("power-electronics");
    expect(keywordTags("Lezioni di elettronica di potenza: convertitori buck")).toContain("power-electronics");
    expect(keywordTags("PID control: control systems course")).toContain("control-systems");
    expect(keywordTags("The physics of quantum mechanics")).toContain("physics");
    expect(keywordTags("Termodinamica e relatività: un corso di fisica")).toContain("physics");
    expect(keywordTags("Deep learning e neural networks")).toContain("machine-learning");
    expect(keywordTags("A day in the life of an engineering student")).toContain("engineering");
  });

  it("niente falsi positivi su parole generiche", () => {
    // "grid" da solo è CSS, "converters" da solo è ADC: nessun tag tematico.
    expect(keywordTags("CSS grid layout: il tutorial definitivo")).toEqual(["guide"]);
    expect(keywordTags("Analog to digital converters explained")).toEqual([]);
  });
});

describe("classifyFile", () => {
  it("i file sono documenti, i PDF hanno tag dedicato", () => {
    expect(classifyFile("relazione.pdf", "application/pdf")).toEqual({
      type: "documento",
      tags: expect.arrayContaining(["documento", "pdf"]),
    });
    expect(classifyFile("archivio.zip").tags).toContain("archivio");
    expect(classifyFile("bozza.docx").tags).toEqual(["documento"]);
  });
});
