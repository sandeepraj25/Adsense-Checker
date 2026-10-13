/**
 * A small, forgiving HTML reader.
 *
 * A real DOM parser (cheerio, jsdom, linkedom) would be nicer, but every
 * one of them is a dependency, and the brief rules out adding those
 * without need. Auditing only requires reading a handful of tags and
 * counting words, which regex handles adequately on real-world markup —
 * and unlike a strict parser it does not fall over on the malformed HTML
 * that sites needing this audit tend to ship.
 */

export type PageLink = {
  href: string;
  text: string;
  absolute: string | null;
  internal: boolean;
};

export type PageAnalysis = {
  url: string;
  status: number;
  ok: boolean;
  title: string;
  metaDescription: string;
  metaRobots: string;
  viewport: string;
  canonical: string;
  lang: string;
  ogTitle: string;
  ogImage: string;
  headings1: string[];
  headings2: string[];
  wordCount: number;
  text: string;
  images: Array<{ src: string; alt: string | null }>;
  links: PageLink[];
  hasNavElement: boolean;
  hasFooterElement: boolean;
  hasMediaQuery: boolean;
  hasForm: boolean;
  wideFixedWidths: number[];
  blocksZoom: boolean;
  legacyPlugins: number;
  bytes: number;
  ms: number;
  /* ── signals the paid checks read ───────────────────────────────── */
  /** Ad units already on the page: AdSense ins tags, GPT slots, ad classes. */
  adSlots: number;
  /** Embedded frames, which are the other common ad and widget carrier. */
  iframes: number;
  /** Paragraph elements, used as a proxy for editorial structure. */
  paragraphCount: number;
  /** Path depth, e.g. /a/b/c => 3. Used by the structure analysis. */
  depth: number;
  /** Byline-ish strings found in the markup ("By Jane Doe", rel=author). */
  bylineHints: string[];
  /** Published/updated date strings, from <time> or visible copy. */
  dateHints: string[];
};

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "-",
  mdash: "-",
  hellip: "...",
  rsquo: "'",
  lsquo: "'",
  rdquo: '"',
  ldquo: '"',
};

export function decodeEntities(input: string): string {
  return input
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16)),
    )
    .replace(/&#(\d+);/g, (_, dec: string) =>
      String.fromCodePoint(Number.parseInt(dec, 10)),
    )
    .replace(/&([a-z]+);/gi, (match, name: string) => {
      const value = ENTITIES[name.toLowerCase()];
      return value ?? match;
    });
}

function collapse(input: string): string {
  return input.replace(/\s+/g, " ").trim();
}

/** Removes anything that is not user-visible prose. */
function visibleText(html: string): string {
  const stripped = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|template|svg|iframe|head)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]*>/g, " ");
  return collapse(decodeEntities(stripped));
}

function attr(tag: string, name: string): string {
  const double = new RegExp(`${name}\\s*=\\s*"([^"]*)"`, "i").exec(tag);
  if (double?.[1] !== undefined) return decodeEntities(double[1]).trim();
  const single = new RegExp(`${name}\\s*=\\s*'([^']*)'`, "i").exec(tag);
  if (single?.[1] !== undefined) return decodeEntities(single[1]).trim();
  const bare = new RegExp(`${name}\\s*=\\s*([^\\s">]+)`, "i").exec(tag);
  return bare?.[1] ? decodeEntities(bare[1]).trim() : "";
}

function metaContent(html: string, key: string, kind: "name" | "property"): string {
  const tags = html.match(/<meta\b[^>]*>/gi) ?? [];
  for (const tag of tags) {
    if (attr(tag, kind).toLowerCase() === key.toLowerCase()) {
      const content = attr(tag, "content");
      if (content) return content;
    }
  }
  return "";
}

function headings(html: string, level: 1 | 2): string[] {
  const found: string[] = [];
  const re = new RegExp(`<h${level}\\b[^>]*>([\\s\\S]*?)</h${level}>`, "gi");
  let match: RegExpExecArray | null;
  while ((match = re.exec(html)) !== null) {
    const text = collapse(decodeEntities((match[1] ?? "").replace(/<[^>]*>/g, " ")));
    if (text) found.push(text.slice(0, 200));
  }
  return found;
}

function toAbsolute(href: string, base: string): string | null {
  const trimmed = href.trim();
  if (
    !trimmed ||
    trimmed.startsWith("#") ||
    /^(mailto|tel|javascript|data|sms|whatsapp):/i.test(trimmed)
  ) {
    return null;
  }
  try {
    const url = new URL(trimmed, base);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

/** Strips `www.` so `example.com` and `www.example.com` count as one site. */
export function registrable(hostname: string): string {
  return hostname.toLowerCase().replace(/^www\./, "");
}

function widthsOver(html: string, threshold: number): number[] {
  const found = new Set<number>();
  const patterns = [
    /width\s*=\s*["']?(\d{3,5})(?:px)?["']?/gi,
    /(?:min-)?width\s*:\s*(\d{3,5})px/gi,
  ];
  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(html)) !== null) {
      const value = Number(match[1]);
      if (Number.isFinite(value) && value > threshold) found.add(value);
    }
  }
  return [...found].sort((a, b) => b - a).slice(0, 6);
}

/**
 * Counts ad units without executing anything.
 *
 * Three shapes cover almost every real placement: the AdSense `<ins>` tag,
 * a Google Publisher Tag slot div, and a container whose class or id says
 * "ad". The last one is deliberately narrow — matching `ad` anywhere in a
 * class name would count "header", "shadow" and "loading".
 */
function countAdSlots(html: string): number {
  let total = 0;
  total += (html.match(/<ins\b[^>]*adsbygoogle/gi) ?? []).length;
  total += (html.match(/id\s*=\s*["'][^"']*div-gpt-ad[^"']*["']/gi) ?? []).length;
  total += (
    html.match(
      /(?:class|id)\s*=\s*["'][^"']*(?:^|[\s_-])(?:ad|ads|advert|advertisement|adslot|banner-ad|sponsored)(?:[\s_-]|["'])/gi,
    ) ?? []
  ).length;
  total += (html.match(/data-ad-(?:client|slot)\s*=/gi) ?? []).length;
  return total;
}

const BYLINE_PATTERNS = [
  /\bby\s+([A-Z][\p{L}'’.-]+(?:\s+[A-Z][\p{L}'’.-]+){0,3})/u,
  /\bwritten by\s+([A-Z][\p{L}'’.-]+(?:\s+[A-Z][\p{L}'’.-]+){0,3})/iu,
  /\bauthor[:\s]+([A-Z][\p{L}'’.-]+(?:\s+[A-Z][\p{L}'’.-]+){0,3})/iu,
];

function bylines(html: string, text: string): string[] {
  const found = new Set<string>();
  for (const tag of html.match(/<[^>]*rel\s*=\s*["']?author[^>]*>/gi) ?? []) {
    const value = attr(tag, "title") || attr(tag, "href");
    if (value) found.add(value.slice(0, 80));
  }
  for (const tag of html.match(/<[^>]*(?:class|itemprop)\s*=\s*["'][^"']*author[^"']*["'][^>]*>/gi) ??
    []) {
    found.add(collapse(tag.replace(/<[^>]*>/g, " ")).slice(0, 80) || "author markup");
  }
  const head = text.slice(0, 4000);
  for (const pattern of BYLINE_PATTERNS) {
    const match = pattern.exec(head);
    if (match?.[1]) found.add(match[1].slice(0, 80));
  }
  return [...found].slice(0, 6);
}

const DATE_TEXT =
  /\b(?:\d{1,2}\s+)?(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2},?\s+(?:19|20)\d{2}\b|\b(?:19|20)\d{2}-\d{2}-\d{2}\b|\b\d{1,2}\/\d{1,2}\/(?:19|20)\d{2}\b/gi;

function dates(html: string, text: string): string[] {
  const found = new Set<string>();
  for (const tag of html.match(/<time\b[^>]*>/gi) ?? []) {
    const value = attr(tag, "datetime");
    if (value) found.add(value.slice(0, 40));
  }
  for (const key of ["article:published_time", "article:modified_time"]) {
    const value = metaContent(html, key, "property");
    if (value) found.add(value.slice(0, 40));
  }
  for (const match of text.slice(0, 6000).match(DATE_TEXT) ?? []) {
    found.add(match.slice(0, 40));
  }
  return [...found].slice(0, 6);
}

function pathDepth(url: string): number {
  try {
    return new URL(url).pathname.split("/").filter(Boolean).length;
  } catch {
    return 0;
  }
}

export function analysePage(input: {
  url: string;
  status: number;
  ok: boolean;
  html: string;
  bytes: number;
  ms: number;
}): PageAnalysis {
  const { html } = input;
  const htmlTag = /<html\b[^>]*>/i.exec(html)?.[0] ?? "";
  const text = visibleText(html);

  const links: PageLink[] = [];
  const anchorRe = /<a\b([^>]*)>([\s\S]{0,600}?)<\/a>/gi;
  let anchor: RegExpExecArray | null;
  const selfHost = (() => {
    try {
      return registrable(new URL(input.url).hostname);
    } catch {
      return "";
    }
  })();

  while ((anchor = anchorRe.exec(html)) !== null && links.length < 600) {
    const raw = attr(`<a ${anchor[1] ?? ""}>`, "href");
    if (!raw) continue;
    const absolute = toAbsolute(raw, input.url);
    let internal = false;
    if (absolute) {
      try {
        internal = registrable(new URL(absolute).hostname) === selfHost;
      } catch {
        internal = false;
      }
    }
    links.push({
      href: raw,
      text: collapse(decodeEntities((anchor[2] ?? "").replace(/<[^>]*>/g, " "))).slice(0, 160),
      absolute,
      internal,
    });
  }

  const images: Array<{ src: string; alt: string | null }> = [];
  for (const tag of html.match(/<img\b[^>]*>/gi) ?? []) {
    if (images.length >= 300) break;
    const src = attr(tag, "src") || attr(tag, "data-src");
    const hasAlt = /\balt\s*=/i.test(tag);
    images.push({ src, alt: hasAlt ? attr(tag, "alt") : null });
  }

  const viewport = metaContent(html, "viewport", "name");
  const words = text.split(" ").filter((token) => /[\p{L}\p{N}]/u.test(token));

  return {
    url: input.url,
    status: input.status,
    ok: input.ok,
    title: collapse(
      decodeEntities(
        (/<title\b[^>]*>([\s\S]{0,400}?)<\/title>/i.exec(html)?.[1] ?? "").replace(
          /<[^>]*>/g,
          " ",
        ),
      ),
    ),
    metaDescription: metaContent(html, "description", "name"),
    metaRobots: metaContent(html, "robots", "name").toLowerCase(),
    viewport,
    canonical: (() => {
      for (const tag of html.match(/<link\b[^>]*>/gi) ?? []) {
        if (/rel\s*=\s*["']?canonical/i.test(tag)) return attr(tag, "href");
      }
      return "";
    })(),
    lang: attr(htmlTag, "lang"),
    ogTitle: metaContent(html, "og:title", "property"),
    ogImage: metaContent(html, "og:image", "property"),
    headings1: headings(html, 1),
    headings2: headings(html, 2),
    wordCount: words.length,
    text: text.slice(0, 40_000),
    images,
    links,
    hasNavElement: /<nav\b/i.test(html) || /role\s*=\s*["']?navigation/i.test(html),
    hasFooterElement: /<footer\b/i.test(html) || /class\s*=\s*["'][^"']*footer/i.test(html),
    hasMediaQuery: /@media\b/i.test(html),
    hasForm: /<form\b/i.test(html) || /<textarea\b/i.test(html),
    wideFixedWidths: widthsOver(html, 640),
    blocksZoom:
      /user-scalable\s*=\s*(no|0)/i.test(viewport) ||
      /maximum-scale\s*=\s*1(\.0)?\b/i.test(viewport),
    legacyPlugins: (html.match(/<(object|embed|applet)\b/gi) ?? []).length,
    bytes: input.bytes,
    ms: input.ms,
    adSlots: countAdSlots(html),
    iframes: (html.match(/<iframe\b/gi) ?? []).length,
    paragraphCount: (html.match(/<p\b/gi) ?? []).length,
    depth: pathDepth(input.url),
    bylineHints: bylines(html, text),
    dateHints: dates(html, text),
  };
}
