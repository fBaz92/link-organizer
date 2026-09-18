import type { ItemType } from "@/core/domain/item";

/*
 * Flow: configurazione EDITABILE del tagger. Ogni regola dichiara dove
 * combacia (dominio con match a suffisso, pattern sul path, keyword nel
 * testo) e cosa assegnare (tag e, opzionalmente, il tipo dell'item).
 *
 * Come aggiungere una categoria: aggiungi una regola qui — il motore in
 * classify.ts non va toccato. Le regole di dominio specifiche vanno PRIMA
 * di quelle generiche (la prima regola con un `type` vince il tipo).
 */

export interface TagRule {
  /** Nome descrittivo, utile in debug e test. */
  name: string;
  /** Tag assegnato quando la regola combacia. */
  tag: string;
  /** Tipo implicito dell'item; la prima regola che combacia vince. */
  type?: ItemType;
  /** Match sull'host, a suffisso: "youtube.com" copre anche "music.youtube.com". */
  domains?: string[];
  /** Match sul path + query dell'URL. */
  pathPatterns?: RegExp[];
  /**
   * Match case-insensitive su titolo+descrizione (arricchimento, mai tipo).
   * Le keyword tematiche preferiscono frasi intere a parole isolate: "grid"
   * da solo è pure CSS, "grid-forming" è power systems.
   */
  textKeywords?: RegExp[];
}

export const TAG_RULES: TagRule[] = [
  // ── Regole specifiche prima: assegnano tipo con precisione ──────────────
  {
    name: "YouTube",
    tag: "video",
    type: "video",
    domains: ["youtube.com", "youtu.be", "youtube-nocookie.com"],
  },
  {
    name: "Vimeo",
    tag: "video",
    type: "video",
    domains: ["vimeo.com"],
  },
  {
    name: "Twitch",
    tag: "video",
    type: "video",
    domains: ["twitch.tv"],
    pathPatterns: [/^\/(?:videos\/|[^/]+\/clip\/)/],
  },
  {
    name: "TikTok",
    tag: "video",
    type: "video",
    domains: ["tiktok.com"],
  },
  {
    name: "Spotify podcast",
    tag: "podcast",
    type: "podcast",
    domains: ["open.spotify.com"],
    pathPatterns: [/^\/episode\//, /^\/show\//],
  },
  {
    name: "Spotify musica",
    tag: "musica",
    type: "musica",
    domains: ["open.spotify.com"],
    pathPatterns: [/^\/(track|album)\//],
  },
  {
    name: "SoundCloud",
    tag: "musica",
    type: "musica",
    domains: ["soundcloud.com"],
  },
  {
    name: "Bandcamp",
    tag: "musica",
    type: "musica",
    domains: ["bandcamp.com"],
  },
  {
    name: "GitHub",
    tag: "repo",
    type: "repo",
    domains: ["github.com", "gist.github.com", "gitlab.com"],
  },
  {
    name: "arXiv",
    tag: "paper",
    type: "paper",
    domains: ["arxiv.org"],
  },
  {
    name: "DOI / accademico",
    tag: "paper",
    type: "paper",
    domains: ["doi.org", "dl.acm.org", "ieeexplore.ieee.org", "semanticscholar.org", "biorxiv.org", "plos.org", "nature.com", "sciencedirect.com", "springer.com"],
  },
  {
    name: "Social post",
    tag: "post",
    type: "post",
    domains: ["x.com", "twitter.com", "threads.net", "bsky.app", "mastodon.social", "facebook.com", "instagram.com", "linkedin.com", "reddit.com"],
  },

  // ── Regole generiche di dominio dopo ────────────────────────────────────
  {
    name: "Podcast generici",
    tag: "podcast",
    type: "podcast",
    domains: ["spreaker.com", "anchor.fm", "podcast_addict.com", "ivoox.com"],
  },
  {
    name: "Video generici",
    tag: "video",
    type: "video",
    domains: ["dailymotion.com", "twitch.tv", "odysee.com", "rumble.com", "peertube"],
  },
  {
    name: "News e blog italiani",
    tag: "articolo",
    type: "articolo",
    domains: ["ilpost.it", "repubblica.it", "corriere.it", "lastampa.it", "ilfattoquotidiano.it", "ansa.it", "rainews.it", "wired.it"],
  },
  {
    name: "News e blog internazionali",
    tag: "articolo",
    type: "articolo",
    domains: ["nytimes.com", "theguardian.com", "bbc.com", "bbc.co.uk", "wired.com", "theverge.com", "arstechnica.com", "theatlantic.com", "economist.com", "medium.com", "substack.com"],
  },
  {
    name: "Documentazione tecnica",
    tag: "documentazione",
    domains: ["developer.mozilla.org", "docs.python.org", "react.dev", "nextjs.org", "sqlite.org"],
  },

  // ── Arricchimento tematico da titolo/descrizione (mai tipo) ─────────────
  // Domini tecnici: pattern multi-parola per tenere la precisione alta
  // (la descrizione è un testo lungo, una keyword ambigua sporcherebbe tutto).
  {
    name: "Tema: power systems",
    tag: "power-systems",
    textKeywords: [
      /\bpower[- ]systems?\b/i,
      /\b(?:power|smart)[- ]grids?\b/i,
      /\btransmission (?:lines?|networks?|systems?)\b/i,
      /\bdistribution (?:grids?|networks?|feeders?|systems?)\b/i,
      /\b(?:load|power)[- ]?flows?\b/i,
      /\bHVDC\b/i,
      /\bsubstations?\b/i,
      /\bgrid[- ](?:forming|following|codes?|compliance|stability|inertia|support)\b/i,
      /\bsynchronous (?:machines?|generators?|condensers?)\b/i,
      /\bfrequency (?:regulation|containment|control|stability|response|support)\b/i,
      /\bsistemi elettrici\b/i,
      /\brete elettrica\b/i,
      /\brenewable energy\b/i,
      /\benergia rinnovabile\b/i,
    ],
  },
  {
    name: "Tema: power electronics",
    tag: "power-electronics",
    textKeywords: [
      /\bpower[- ]electronics?\b/i,
      /\belettronica di potenza\b/i,
      /\b(?:dc[- ]?dc|buck|boost|buck[- ]boost|Ćuk|cuk|SEPIC|flyback|forward|half[- ]bridge|full[- ]bridge|LLC|resonant|isolated) converters?\b/i,
      /\binverters?\b/i,
      /\brectifiers?\b/i,
      /\bPWM\b/i,
      /\bpower factor correction\b/i,
      /\bPFC\b/i,
      /\b(?:motor|servo) drives?\b/i,
      /\b(?:SiC|GaN) (?:MOSFETs?|FETs?|diodes?|devices?|power|transistors?|based|converters?|inverters?|modules?)\b/i,
      /\bsilicon carbide\b/i,
      /\bgallium nitride\b/i,
      /\bcarburo di silicio\b/i,
      /\bnitruro di gallio\b/i,
      /\bwide[- ]band[- ]?gap\b/i,
      /\bspace[- ]vector (?:modulation|control)\b/i,
      /\bMPPT\b/i,
      /\bswitching (?:losses|transients)\b/i,
    ],
  },
  {
    name: "Tema: control systems",
    tag: "control-systems",
    textKeywords: [
      /\bcontrol (?:systems?|theory|engineering)\b/i,
      /\bautomatic control\b/i,
      /\bcontrollo automatico\b/i,
      /\bPID controllers?\b/i,
      /\bstate[- ]space\b/i,
      /\btransfer functions?\b/i,
      /\b(?:Bode|Nyquist) (?:plots?|diagrams?|criteri(?:on|a))\b/i,
      /\bfeedback (?:control|loops?|systems?)\b/i,
    ],
  },
  {
    name: "Tema: machine learning",
    tag: "machine-learning",
    textKeywords: [
      /\bmachine learning\b/i,
      /\bdeep learning\b/i,
      /\bneural networks?\b/i,
      /\bapprendimento automatico\b/i,
      /\breinforcement learning\b/i,
    ],
  },
  {
    name: "Tema: physics",
    tag: "physics",
    textKeywords: [
      /\bphysics\b/i,
      /\bfisica\b/i,
      /\bquantum\b/i,
      /\bquantistic[oa]\b/i,
      /\brelativit(?:y|à)\b/i,
      /\bthermodynamics?\b/i,
      /\btermodinamica\b/i,
      /\belectromagnetism\b/i,
      /\belettromagnetismo\b/i,
      /\belectrodynamics\b/i,
      /\belettrodinamica\b/i,
      /\bMaxwell(?:'s)? equations\b/i,
      /\b(?:Lagrangian|Hamiltonian)\b/i,
      /\bmeccanica (?:classica|quantistica|analitica|celeste|statistica)\b/i,
      /\bstatistical mechanics\b/i,
      /\bastrophysics\b/i,
      /\bastrofisica\b/i,
      /\bcosmology\b/i,
      /\bcosmologia\b/i,
      /\bparticle physics\b/i,
      /\bfisica delle particelle\b/i,
      /\bsolid[- ]state physics\b/i,
    ],
  },
  {
    name: "Tema: engineering (generico)",
    tag: "engineering",
    textKeywords: [/\bengineering\b/i, /\bingegneri[aà]\b/i],
  },

  // ── Arricchimento generico da titolo/descrizione (mai tipo) ─────────────
  {
    name: "Keyword: talk e conferenze",
    tag: "talk",
    textKeywords: [/\btalk\b/i, /\bkeynote\b/i, /\bconference\b/i, /\bconferenza\b/i],
  },
  {
    name: "Keyword: tutorial e guide",
    tag: "guide",
    textKeywords: [/tutorial/i, /\bhow[- ]to\b/i, /\bguida\b/i, /\bcome costruire\b/i],
  },
];
