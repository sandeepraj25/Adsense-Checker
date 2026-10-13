import type { PageAnalysis } from "./html";

/**
 * Text signals for the paid content checks.
 *
 * ────────────────────────────────────────────────────────────────────
 *  WHAT THIS IS, AND WHAT IT IS NOT
 * ────────────────────────────────────────────────────────────────────
 *  These are heuristics computed from the text we fetched. They are
 *  *estimates* and every string they produce says so. There is no
 *  classifier here, no model, no external provider, and therefore no
 *  determination of authorship and no plagiarism verdict.
 *
 *  That is a deliberate product decision, not a gap. Reliable detection
 *  of machine-written prose is an open problem — published detectors
 *  disagree with each other and with themselves on paraphrased text, and
 *  they misfire hardest on exactly the kind of writing this audience
 *  produces (concise, templated, non-native English). Presenting a
 *  heuristic as a verdict would mean telling a customer their own
 *  writing is fake. So the vocabulary throughout is "signals",
 *  "estimate" and "reads like"; nothing returns "AI-generated" and
 *  nothing returns "plagiarised".
 *
 *  Duplicate detection is different in kind: comparing pages *we
 *  fetched from the same site* against each other is a measurement, not
 *  a guess, and it is reported as one. What it cannot do is find copies
 *  elsewhere on the web — that needs a corpus we do not have.
 */

/* ── shared text utilities ──────────────────────────────────────── */

export function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+(?=[A-Z"'(\p{Lu}])/u)
    .map((part) => part.trim())
    .filter((part) => part.split(/\s+/).length >= 3);
}

function words(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}'-]+/u)
    .filter((token) => token.length > 1);
}

function mean(values: number[]): number {
  return values.length === 0
    ? 0
    : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function stdev(values: number[]): number {
  if (values.length < 2) return 0;
  const average = mean(values);
  const variance =
    values.reduce((sum, value) => sum + (value - average) ** 2, 0) /
    (values.length - 1);
  return Math.sqrt(variance);
}

function clamp(value: number, low = 0, high = 100): number {
  return Math.max(low, Math.min(high, value));
}

/* ── machine-written estimate ───────────────────────────────────── */

/**
 * Phrasing that shows up far more often in generated prose than in
 * edited human copy. Individually each is innocent — a human can write
 * "it is important to note". The signal is the *density* of them.
 */
const MACHINE_PHRASES: RegExp[] = [
  /\bit is important to note\b/i,
  /\bit'?s worth noting\b/i,
  /\bin (?:today'?s|the) (?:digital )?(?:world|age|landscape|era)\b/i,
  /\bin conclusion\b/i,
  /\bto sum up\b/i,
  /\bfurthermore\b/i,
  /\bmoreover\b/i,
  /\badditionally,/i,
  /\bin summary\b/i,
  /\bdelve into\b/i,
  /\ba testament to\b/i,
  /\brich tapestry\b/i,
  /\bever-?(?:evolving|changing) landscape\b/i,
  /\bplays? a (?:crucial|vital|pivotal|significant) role\b/i,
  /\bnavigate the (?:complexities|world|landscape)\b/i,
  /\bunlock the (?:potential|power|secrets)\b/i,
  /\bwhen it comes to\b/i,
  /\bnot only .{0,40} but also\b/i,
  /\bby leveraging\b/i,
  /\bseamless(?:ly)?\b/i,
  /\bholistic approach\b/i,
  /\bcomprehensive (?:guide|overview|understanding)\b/i,
  /\bthis (?:article|guide|post) (?:will )?(?:explores?|delves?|covers?|discusses?)\b/i,
  /\blet'?s dive in\b/i,
  /\bkey takeaways?\b/i,
  /\bfrequently asked questions\b/i,
  /\bin the realm of\b/i,
  /\bas an ai\b/i,
  /\bi (?:cannot|can'?t) (?:provide|generate)\b/i,
];

/** Contractions, asides and first-person marks that survive editing. */
const HUMAN_PHRASES: RegExp[] = [
  /\b(?:i|we)(?:'| )(?:ve|ll|d|m|re)\b/i,
  /\b(?:don'?t|didn'?t|wasn'?t|isn'?t|can'?t|won'?t|couldn'?t)\b/i,
  /\b(?:honestly|frankly|actually|basically|anyway|though)\b/i,
  /\bin my (?:experience|opinion|view)\b/i,
  /\bwe (?:found|noticed|tried|learned|decided)\b/i,
  /\b(?:last|this) (?:week|month|year) (?:i|we)\b/i,
  /—|—/,
  /\?\s/,
];

export type AiEstimate = {
  /** 0–100. Higher means the text reads more like generated prose. */
  score: number;
  /** "low" | "moderate" | "elevated" — the band the score falls in. */
  band: "low" | "moderate" | "elevated";
  /** The measurements that moved the number, for the report. */
  reasons: string[];
  /** Words the estimate was computed from. Small samples are unreliable. */
  sampleWords: number;
  /** False when there was too little text to say anything. */
  reliable: boolean;
};

/**
 * Estimates how machine-written a passage reads.
 *
 * Four measurements, each weak on its own:
 *
 *  1. Sentence-length uniformity. Generated prose clusters tightly
 *     around a comfortable length; human writing varies more, because a
 *     person occasionally writes a very short sentence for effect.
 *  2. Connective and stock-phrase density.
 *  3. Vocabulary spread (type–token ratio), normalised for length.
 *  4. Paragraph-length uniformity.
 *
 * The result is a weighted blend, floored and capped, and always
 * returned with `reliable: false` under 200 words — below that the
 * variance measures are noise.
 */
export function estimateAiLikelihood(text: string): AiEstimate {
  const sample = text.slice(0, 20_000);
  const tokens = words(sample);
  const lines = sentences(sample);
  const reasons: string[] = [];

  if (tokens.length < 200 || lines.length < 6) {
    return {
      score: 0,
      band: "low",
      reasons: ["Too little text on this page to estimate anything from."],
      sampleWords: tokens.length,
      reliable: false,
    };
  }

  const lengths = lines.map((line) => line.split(/\s+/).length);
  const average = mean(lengths);
  const spread = stdev(lengths);
  // Coefficient of variation. Edited human prose usually lands above
  // 0.45; tightly uniform output tends to sit under 0.3.
  const variation = average === 0 ? 1 : spread / average;
  const uniformity = clamp((0.55 - variation) * 220);
  if (uniformity > 40) {
    reasons.push(
      `Sentence lengths are unusually uniform (average ${Math.round(average)} words, spread ±${spread.toFixed(1)}).`,
    );
  }

  const hits = MACHINE_PHRASES.filter((pattern) => pattern.test(sample));
  const per1k = (hits.length / tokens.length) * 1000;
  const phrasing = clamp(per1k * 55);
  if (hits.length >= 3) {
    reasons.push(
      `${hits.length} stock connective or filler phrases in ${tokens.length} words.`,
    );
  }

  const unique = new Set(tokens).size;
  // Type–token ratio falls naturally with length, so compare against a
  // length-adjusted expectation rather than a flat threshold.
  const expected = 0.72 - Math.min(0.34, Math.log10(tokens.length / 100) * 0.19);
  const ratio = unique / tokens.length;
  const vocabulary = clamp((expected - ratio) * 420);
  if (vocabulary > 40) {
    reasons.push(
      `Vocabulary is narrow for the length (${unique} distinct words across ${tokens.length}).`,
    );
  }

  const paragraphs = sample
    .split(/\n{2,}/)
    .map((part) => part.split(/\s+/).length)
    .filter((count) => count > 15);
  const paragraphSpread =
    paragraphs.length >= 4 ? stdev(paragraphs) / Math.max(1, mean(paragraphs)) : 0.5;
  const rhythm = paragraphs.length >= 4 ? clamp((0.5 - paragraphSpread) * 180) : 0;

  const humanHits = HUMAN_PHRASES.filter((pattern) => pattern.test(sample)).length;
  const humanCredit = Math.min(22, humanHits * 4);
  if (humanHits >= 3) {
    reasons.push(
      `${humanHits} first-person or conversational markers, which push the estimate down.`,
    );
  }

  const score = clamp(
    Math.round(
      uniformity * 0.34 +
        phrasing * 0.3 +
        vocabulary * 0.22 +
        rhythm * 0.14 -
        humanCredit,
    ),
  );

  if (reasons.length === 0) {
    reasons.push("No strong signals either way in this text.");
  }

  return {
    score,
    band: score >= 65 ? "elevated" : score >= 40 ? "moderate" : "low",
    reasons,
    sampleWords: tokens.length,
    reliable: true,
  };
}

/* ── human-authorship signals (Pro) ─────────────────────────────── */

export type HumanEstimate = {
  /** 0–100. Higher means more evidence a person stands behind the page. */
  score: number;
  present: string[];
  missing: string[];
};

export function estimateHumanSignals(pages: PageAnalysis[]): HumanEstimate {
  const present: string[] = [];
  const missing: string[] = [];
  let score = 0;

  const withByline = pages.filter((page) => page.bylineHints.length > 0);
  if (withByline.length > 0) {
    score += 26;
    present.push(
      `bylines or author markup on ${withByline.length} of ${pages.length} pages`,
    );
  } else {
    missing.push("a named author or byline on any page");
  }

  const withDate = pages.filter((page) => page.dateHints.length > 0);
  if (withDate.length > 0) {
    score += 20;
    present.push(`published or updated dates on ${withDate.length} pages`);
  } else {
    missing.push("published or updated dates");
  }

  const firstPerson = pages.filter((page) =>
    /\b(?:i|we|our|my)\b/i.test(page.text.slice(0, 6000)),
  );
  if (firstPerson.length >= Math.max(1, Math.floor(pages.length / 2))) {
    score += 18;
    present.push("first-person voice in the body copy");
  } else {
    missing.push("first-person voice — the copy reads impersonally throughout");
  }

  const structured = pages.filter(
    (page) => page.paragraphCount >= 4 && page.headings2.length >= 1,
  );
  if (structured.length >= Math.max(1, Math.floor(pages.length / 2))) {
    score += 18;
    present.push("paragraphs and subheadings rather than one undivided block");
  } else {
    missing.push("editorial structure — subheadings and separated paragraphs");
  }

  const contactable = pages.some((page) => page.hasForm);
  if (contactable) {
    score += 10;
    present.push("a form a reader can actually use to reach you");
  }

  const varied = new Set(pages.flatMap((page) => page.bylineHints)).size;
  if (varied > 1) {
    score += 8;
    present.push(`${varied} distinct author names`);
  }

  return { score: clamp(score), present, missing };
}

/* ── originality signals (Basic) ────────────────────────────────── */

const BOILERPLATE: Array<{ term: RegExp; label: string }> = [
  { term: /\bthis (?:is a|website is a) (?:demo|sample|test) (?:site|page)\b/i, label: "demo-site copy" },
  { term: /\bwelcome to (?:our|my) (?:new )?(?:website|blog|site)!?\s*(?:this is)?/i, label: 'a generic "welcome to our website" opener' },
  { term: /\bwe are a leading provider of\b/i, label: '"a leading provider of" boilerplate' },
  { term: /\bcustomer satisfaction is our (?:top )?priority\b/i, label: "stock mission-statement phrasing" },
  { term: /\bwith years of experience in the industry\b/i, label: '"years of experience" filler' },
  { term: /\bour team of (?:experts|professionals) (?:is|are) dedicated\b/i, label: '"team of dedicated experts" filler' },
  { term: /\bcontent goes here\b/i, label: "a template content slot" },
  { term: /\bedit or delete (?:it|this),? then start (?:writing|blogging)\b/i, label: "the default WordPress first post" },
  { term: /\bcategory: uncategori[sz]ed\b/i, label: "posts left in Uncategorised" },
  { term: /\bpowered by (?:a )?(?:free )?(?:template|theme) (?:by|from)\b/i, label: "an unedited theme credit" },
];

const SYNDICATION: Array<{ term: RegExp; label: string }> = [
  { term: /\bthis (?:article|post|story) (?:first |originally )?appeared (?:on|in|at)\b/i, label: '"originally appeared on" attribution' },
  { term: /\brepublished (?:with permission|from)\b/i, label: "a republication notice" },
  { term: /\bsource\s*:\s*(?:reuters|ap|pti|ians|ani|bloomberg|afp)\b/i, label: "a wire-service credit" },
  { term: /\bcontent (?:provided|syndicated) by\b/i, label: "syndicated-content markup" },
  { term: /\breprinted (?:with permission|from)\b/i, label: "a reprint notice" },
  { term: /\bpress release\b/i, label: "press-release copy" },
  { term: /\b(?:image|photo) (?:courtesy|credit)\s*:\s*(?:shutterstock|istock|getty|pexels|unsplash|freepik)\b/i, label: "stock-image credits" },
];

export type OriginalitySignals = {
  /** 0–100, higher is better. A composite, not a plagiarism score. */
  score: number;
  boilerplate: string[];
  syndication: string[];
  /** Share of pages whose text is near-identical to another page. */
  duplicateShare: number;
  notes: string[];
};

export function originalitySignals(
  pages: PageAnalysis[],
  duplicateShare: number,
): OriginalitySignals {
  const corpus = pages.map((page) => page.text).join("\n\n").slice(0, 120_000);
  const boilerplate = BOILERPLATE.filter((entry) => entry.term.test(corpus)).map(
    (entry) => entry.label,
  );
  const syndication = SYNDICATION.filter((entry) => entry.term.test(corpus)).map(
    (entry) => entry.label,
  );

  const notes: string[] = [];
  let score = 100;

  score -= Math.min(36, boilerplate.length * 12);
  score -= Math.min(30, syndication.length * 10);
  score -= Math.round(duplicateShare * 34);

  const thin = pages.filter((page) => page.wordCount < 200).length;
  if (pages.length > 0 && thin / pages.length > 0.5) {
    score -= 12;
    notes.push(
      `${thin} of ${pages.length} pages we read carry under 200 words, so there is little original text to assess.`,
    );
  }

  if (boilerplate.length === 0 && syndication.length === 0) {
    notes.push("No template filler or syndication markers in the pages we read.");
  }

  return {
    score: clamp(score),
    boilerplate,
    syndication,
    duplicateShare,
    notes,
  };
}

/* ── duplicate and near-duplicate detection ─────────────────────── */

const SHINGLE = 7;

function shingles(text: string): Set<string> {
  const tokens = words(text.slice(0, 40_000));
  const set = new Set<string>();
  for (let index = 0; index + SHINGLE <= tokens.length; index += 1) {
    set.add(tokens.slice(index, index + SHINGLE).join(" "));
  }
  return set;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let shared = 0;
  for (const value of small) if (large.has(value)) shared += 1;
  return shared / (a.size + b.size - shared);
}

export type DuplicatePair = {
  a: string;
  b: string;
  /** Overlap as a percentage of shared seven-word sequences. */
  overlap: number;
  kind: "duplicate" | "near-duplicate";
};

export type DuplicateReport = {
  pairs: DuplicatePair[];
  /** Share of pages involved in at least one pair, 0–1. */
  share: number;
  comparable: number;
};

/**
 * Compares every readable page against every other by overlapping
 * seven-word sequences.
 *
 * Shingling rather than string equality, because the interesting case is
 * a page rebuilt from the same paragraphs in a different order — which a
 * hash comparison misses entirely and a reviewer does not. Pages under
 * 120 words are excluded: short pages share boilerplate legitimately and
 * would produce nothing but false pairs. O(n²) is fine at the crawl sizes
 * here (at most a few dozen pages).
 */
export function findDuplicates(pages: PageAnalysis[]): DuplicateReport {
  const comparable = pages.filter((page) => page.wordCount >= 120);
  const prints = comparable.map((page) => ({
    url: page.url,
    set: shingles(page.text),
  }));

  const pairs: DuplicatePair[] = [];
  const involved = new Set<string>();

  for (let i = 0; i < prints.length; i += 1) {
    for (let j = i + 1; j < prints.length; j += 1) {
      const left = prints[i];
      const right = prints[j];
      if (!left || !right) continue;
      const overlap = jaccard(left.set, right.set);
      if (overlap < 0.45) continue;
      pairs.push({
        a: left.url,
        b: right.url,
        overlap: Math.round(overlap * 100),
        kind: overlap >= 0.8 ? "duplicate" : "near-duplicate",
      });
      involved.add(left.url);
      involved.add(right.url);
    }
  }

  pairs.sort((a, b) => b.overlap - a.overlap);

  return {
    pairs: pairs.slice(0, 12),
    share: comparable.length === 0 ? 0 : involved.size / comparable.length,
    comparable: comparable.length,
  };
}

/* ── ad density (Pro) ───────────────────────────────────────────── */

export type AdDensity = {
  /** Ad units per thousand words across the pages we read. */
  perThousandWords: number;
  slots: number;
  iframes: number;
  words: number;
  /** Pages whose ad count outweighs their content. */
  crowded: Array<{ url: string; slots: number; words: number }>;
};

export function adDensity(pages: PageAnalysis[]): AdDensity {
  const slots = pages.reduce((sum, page) => sum + page.adSlots, 0);
  const iframes = pages.reduce((sum, page) => sum + page.iframes, 0);
  const totalWords = pages.reduce((sum, page) => sum + page.wordCount, 0);
  const crowded = pages
    .filter((page) => page.adSlots >= 3 && page.wordCount < page.adSlots * 150)
    .map((page) => ({ url: page.url, slots: page.adSlots, words: page.wordCount }))
    .slice(0, 6);

  return {
    perThousandWords:
      totalWords === 0 ? 0 : Math.round((slots / totalWords) * 1000 * 10) / 10,
    slots,
    iframes,
    words: totalWords,
    crowded,
  };
}

/* ── site structure (Pro) ───────────────────────────────────────── */

export type StructureReport = {
  maxDepth: number;
  averageDepth: number;
  /** Discovered URLs nothing else links to, beyond the homepage. */
  orphans: string[];
  /** Top-level sections, e.g. /blog, /about. */
  sections: string[];
  /** Pages the homepage links to directly. */
  hubLinks: number;
};

export function analyseStructure(
  pages: PageAnalysis[],
  internalUrls: string[],
): StructureReport {
  const depths = pages.map((page) => page.depth);
  const inbound = new Map<string, number>();
  for (const page of pages) {
    for (const link of page.links) {
      if (!link.internal || !link.absolute) continue;
      inbound.set(link.absolute, (inbound.get(link.absolute) ?? 0) + 1);
    }
  }

  const home = pages[0];
  const orphans = pages
    .slice(1)
    .filter((page) => (inbound.get(page.url) ?? 0) === 0)
    .map((page) => page.url)
    .slice(0, 8);

  const sections = [
    ...new Set(
      internalUrls
        .map((url) => {
          try {
            return new URL(url).pathname.split("/").filter(Boolean)[0] ?? "";
          } catch {
            return "";
          }
        })
        .filter((part) => part.length > 0 && !/\.[a-z0-9]{2,5}$/i.test(part)),
    ),
  ].slice(0, 14);

  return {
    maxDepth: depths.length === 0 ? 0 : Math.max(...depths),
    averageDepth: Math.round(mean(depths) * 10) / 10,
    orphans,
    sections,
    hubLinks: home ? home.links.filter((link) => link.internal).length : 0,
  };
}

/* ── sitemap parsing (Pro) ──────────────────────────────────────── */

export type SitemapReport = {
  /** URLs listed across the sitemap and any child sitemaps we read. */
  urls: string[];
  /** Child sitemaps referenced by an index. */
  children: string[];
  /** Listed URLs pointing at a different host. */
  offDomain: string[];
  isIndex: boolean;
};

/**
 * Reads a sitemap without an XML parser.
 *
 * `<loc>` is the only element that matters here, and pulling it with a
 * regex avoids both a dependency and the XXE surface that comes with a
 * real parser pointed at attacker-supplied documents.
 */
export function parseSitemap(xml: string, host: string): SitemapReport {
  const isIndex = /<sitemapindex\b/i.test(xml);
  const locations: string[] = [];
  const re = /<loc\b[^>]*>\s*([^<\s]+)\s*<\/loc>/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(xml)) !== null && locations.length < 5_000) {
    const value = match[1];
    if (value) locations.push(value.trim());
  }

  const offDomain = locations.filter((url) => {
    try {
      return new URL(url).hostname.replace(/^www\./, "") !== host.replace(/^www\./, "");
    } catch {
      return true;
    }
  });

  return {
    urls: isIndex ? [] : locations,
    children: isIndex ? locations.slice(0, 8) : [],
    offDomain: offDomain.slice(0, 8),
    isIndex,
  };
}

/* ── ads.txt (Pro) ──────────────────────────────────────────────── */

export type AdsTxtReport = {
  found: boolean;
  lines: number;
  hasGoogle: boolean;
  publisherIds: string[];
};

export function parseAdsTxt(text: string): AdsTxtReport {
  const rows = text
    .split(/\r?\n/)
    .map((line) => line.replace(/#.*$/, "").trim())
    .filter((line) => line.length > 0);
  const google = rows.filter((row) => /google\.com/i.test(row));
  const publisherIds = [
    ...new Set(
      rows.flatMap((row) => row.match(/\bpub-\d{10,20}\b/gi) ?? []),
    ),
  ].slice(0, 4);

  return {
    found: rows.length > 0,
    lines: rows.length,
    hasGoogle: google.length > 0,
    publisherIds,
  };
}
