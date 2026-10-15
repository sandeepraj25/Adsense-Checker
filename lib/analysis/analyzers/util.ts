import type { CheerioAPI } from "cheerio";

import type { CrawledPage } from "../crawler";
import type { SiteMeta } from "./contract";

/**
 * Text and markup helpers shared by the analyzers. Everything here is pure
 * and works on an already-fetched page, so analyzers stay cheap and every
 * one of them reads a page the same way.
 */

/** Elements that never carry what a reader sees as the page's content. */
const NEVER_CONTENT = "script, style, noscript, template, svg, iframe, object, embed, head";
/** Template regions: navigation, chrome, sidebars and forms. */
const TEMPLATE = "nav, header, footer, aside, form, [role=navigation], [role=banner], [role=contentinfo], [role=complementary], .sidebar, #sidebar, .widget, .menu, #comments, .comments";
const HIDDEN = "[hidden], [aria-hidden=true], [style*='display:none'], [style*='display: none'], [style*='visibility:hidden'], [style*='visibility: hidden']";

const BLOCK = new Set(["p", "div", "section", "article", "main", "li", "ul", "ol", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "pre", "table", "tr", "td", "th", "br", "dd", "dt", "figcaption", "header", "footer", "nav", "aside"]);

type Node = { type: string; name?: string; data?: string; children?: Node[] };

/** Text of a subtree with block boundaries turned into spaces, so words never run together. */
function textOf(node: Node): string {
  if (node.type === "text") return node.data ?? "";
  if (node.type !== "tag" && node.type !== "root" && node.type !== "script" && node.type !== "style") return "";
  if (node.type === "script" || node.type === "style") return "";
  const inner = (node.children ?? []).map(textOf).join("");
  return node.name && BLOCK.has(node.name) ? ` ${inner} ` : inner;
}

/**
 * The text of a cheerio selection with a space between block elements.
 * cheerio's own .text() runs "<h1>A</h1><p>By Priya</p>" together as
 * "ABy Priya", which breaks word matching; use this for anything larger
 * than a single inline element. Scripts and styles are skipped.
 */
export function textOfSelection(selection: { toArray(): unknown[] }): string {
  return squash(selection.toArray().map((n) => textOf(n as Node)).join(" "));
}

export function squash(text: string): string {
  return text.replace(/ /g, " ").replace(/\s+/g, " ").trim();
}

/** Everything a visitor can read on the page (scripts, styles and hidden elements removed). */
export function visibleText($: CheerioAPI): string {
  // cheerio always builds <html><body>, even for a fragment or empty input.
  const body = $("body").first().clone();
  body.find(NEVER_CONTENT).remove();
  body.find(HIDDEN).remove();
  return squash(body.toArray().map((n) => textOf(n as unknown as Node)).join(" "));
}

/**
 * The page's own content: <main> or the largest <article> when the page
 * marks one up, else the body — minus navigation, header, footer,
 * sidebars, forms, scripts and hidden elements.
 */
export function mainContent($: CheerioAPI): string {
  const candidates = [...$("main").toArray(), ...$("article").toArray(), ...$("[role=main]").toArray()];
  let root = $("body").first();
  if (candidates.length > 0) {
    const sized = candidates.map((el) => ({ el, size: $(el).text().length }));
    sized.sort((a, b) => b.size - a.size);
    const best = sized[0];
    if (best && best.size > 200) root = $(best.el);
  }
  const copy = root.clone();
  copy.find(NEVER_CONTENT).remove();
  copy.find(HIDDEN).remove();
  copy.find(TEMPLATE).remove();
  return squash(copy.toArray().map((n) => textOf(n as unknown as Node)).join(" "));
}

/** Word tokens (letters and digits, any script). */
export function words(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) ?? [];
}

export function wordCount(text: string): number {
  return words(text).length;
}

/** Sentences, roughly: split on . ! ? followed by space/end, ignoring short fragments. */
export function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+(?=[\p{Lu}\p{N}"“'])/u)
    .map((s) => s.trim())
    .filter((s) => wordCount(s) >= 3);
}

/** English syllable estimate (vowel groups, silent e, -le), at least 1 per word. */
export function syllables(word: string): number {
  const w = word.toLowerCase().replace(/[^a-z]/g, "");
  if (w.length === 0) return 0;
  if (w.length <= 3) return 1;
  const trimmed = w.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, "").replace(/^y/, "");
  const groups = trimmed.match(/[aeiouy]{1,2}/g);
  return Math.max(1, groups ? groups.length : 1);
}

/** Overlapping n-word sequences, for similarity. */
export function shingles(tokens: string[], size: number): Set<string> {
  const set = new Set<string>();
  for (let i = 0; i + size <= tokens.length; i += 1) set.add(tokens.slice(i, i + size).join(" "));
  return set;
}

/** Share of `a`'s shingles that also occur in `b` (containment, 0–1). */
export function containment(a: Set<string>, b: Set<string>): number {
  if (a.size === 0) return 0;
  let shared = 0;
  for (const value of a) if (b.has(value)) shared += 1;
  return shared / a.size;
}

/** A short excerpt around a match, for evidence. */
export function excerpt(text: string, index: number, length: number, around = 60): string {
  const start = Math.max(0, index - around);
  const end = Math.min(text.length, index + length + around);
  return `${start > 0 ? "…" : ""}${text.slice(start, end).trim()}${end < text.length ? "…" : ""}`;
}

/** The host a URL points at, without www, or null. */
export function hostOf(url: string, base?: string): string | null {
  try {
    return new URL(url, base).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

/** True when `host` is the site itself or one of its subdomains. */
export function isOwnHost(host: string | null, siteHost: string): boolean {
  if (!host) return false;
  return host === siteHost || host.endsWith(`.${siteHost}`) || siteHost.endsWith(`.${host}`);
}

/** Pages that carry content (not the required policy pages), homepage included. */
export function contentPagesOf(pages: CrawledPage[], site: SiteMeta): CrawledPage[] {
  const policy = new Set(Object.values(site.policyLinks).flatMap((link) => (link ? [link.url] : [])));
  const rest = pages.filter((page) => page.ok && !policy.has(page.url) && !policy.has(page.finalUrl));
  return rest.length > 0 ? rest : pages.filter((page) => page.ok);
}

/** Whether a page looks like an article/post rather than a hub page. */
export function looksLikePost(page: CrawledPage): boolean {
  const $ = page.$();
  if ($('meta[property="og:type"][content="article"]').length) return true;
  if ($("article").length === 1 && $("article time, article [datetime]").length > 0) return true;
  try {
    const path = new URL(page.finalUrl).pathname;
    if (/\/(19|20)\d{2}\/\d{1,2}\//.test(path)) return true;
    if (/\/(blog|post|posts|article|articles|news|recipes?|guides?)\/[^/]+\/?$/i.test(path)) return true;
  } catch {
    /* not a URL */
  }
  return false;
}

/* ── dates ─────────────────────────────────────────────────────── */

export type FoundDate = { date: Date; source: string; pageUrl: string };

/**
 * Publication dates on a page, from the most to least reliable source:
 * article:published_time, JSON-LD datePublished, <time datetime>, a dated
 * URL. Dates in the future (beyond a day) or before 1995 are ignored.
 */
export function publicationDates(page: CrawledPage, now = Date.now()): FoundDate[] {
  const $ = page.$();
  const found: FoundDate[] = [];
  const add = (raw: string | undefined, source: string) => {
    if (!raw) return;
    const date = new Date(raw.trim());
    const t = date.getTime();
    if (!Number.isFinite(t) || t > now + 86_400_000 || date.getUTCFullYear() < 1995) return;
    found.push({ date, source, pageUrl: page.finalUrl });
  };
  $('meta[property="article:published_time"], meta[name="article:published_time"], meta[itemprop="datePublished"]').each((_, el) =>
    add($(el).attr("content"), "article metadata"),
  );
  $('script[type="application/ld+json"]').each((_, el) => {
    const text = $(el).text().slice(0, 50_000);
    for (const match of text.matchAll(/"datePublished"\s*:\s*"([^"]{8,40})"/g)) add(match[1], "structured data");
  });
  $("time[datetime]").each((_, el) => add($(el).attr("datetime"), "<time> tag"));
  try {
    const m = new URL(page.finalUrl).pathname.match(/\/((?:19|20)\d{2})\/(\d{1,2})(?:\/(\d{1,2}))?\//);
    if (m) add(`${m[1]}-${m[2]!.padStart(2, "0")}-${(m[3] ?? "01").padStart(2, "0")}T00:00:00Z`, "date in the URL");
  } catch {
    /* ignore */
  }
  return found;
}

/** The page's declared language, lower-cased primary subtag ("en"). */
export function declaredLanguage($: CheerioAPI): string {
  return ($("html").attr("lang") ?? "").trim().toLowerCase().split(/[-_]/)[0] ?? "";
}

const ENGLISH_STOPWORDS = new Set(["the", "and", "to", "of", "a", "in", "is", "it", "you", "that", "for", "on", "with", "as", "this", "was", "are", "be", "at", "or", "your", "have", "from", "but", "not", "by", "we", "they", "can", "an", "will", "my", "if", "so", "do"]);

/** Share of tokens that are common English function words — a cheap "is this English?" test. */
export function englishShare(tokens: string[]): number {
  if (tokens.length === 0) return 0;
  return tokens.filter((t) => ENGLISH_STOPWORDS.has(t)).length / tokens.length;
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

export function pct(value: number): string {
  return `${Math.round(value * 100)}%`;
}
