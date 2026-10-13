/**
 * Reducing what a browser sends to the least we need.
 *
 * Every function here throws information away on purpose: a URL becomes
 * a pathname with ids collapsed, a referrer becomes a host name and a
 * category, a user agent becomes three coarse labels. Nothing in this
 * file keeps a query string, so a code, token or email address that
 * happened to be in a link can never reach the database.
 */

const MAX_PATH = 160;

/** Segments that identify a record or a person, not a page. */
function looksLikeId(segment: string): boolean {
  if (segment.length >= 24) return true;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(segment)) return true;
  if (/^[a-z]{2,8}_[A-Za-z0-9_-]{6,}$/.test(segment)) return true; // rep_xxx, inv_xxx, pay_xxx
  if (/^RPT-[A-Z0-9]{4,}$/i.test(segment)) return true;
  if (/^\d{3,}$/.test(segment)) return true;
  if (segment.length >= 12 && /\d/.test(segment) && /[a-z]/i.test(segment)) return true;
  if (segment.includes("@")) return true;
  return false;
}

/**
 * "/dashboard/reports/rep_8f2k?x=1#y" → "/dashboard/reports/[id]".
 * Returns null for anything that is not a same-site page path.
 */
export function sanitizePath(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 2048) return null;
  if (!raw.startsWith("/") || raw.startsWith("//")) return null;
  let pathname = raw.split(/[?#]/, 1)[0];
  try {
    pathname = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (/[\u0000-\u001f\u007f\\]/.test(pathname)) return null;
  const segments = pathname
    .split("/")
    .filter(Boolean)
    .map((segment) => (looksLikeId(segment) ? "[id]" : segment.toLowerCase()));
  for (const segment of segments) {
    if (segment !== "[id]" && !/^[a-z0-9._~-]+$/.test(segment)) return null;
  }
  const out = `/${segments.join("/")}`;
  return out.length > MAX_PATH ? out.slice(0, MAX_PATH) : out;
}

/** Paths that are never recorded: the admin panel and API endpoints. */
export function isExcludedPath(path: string): boolean {
  return path === "/admin" || path.startsWith("/admin/") || path.startsWith("/api/");
}

/* ── referrers ──────────────────────────────────────────────────── */

export type ReferrerType = "direct" | "search" | "social" | "email" | "paid" | "referral";

const SEARCH = /(^|\.)(google|bing|duckduckgo|yahoo|yandex|baidu|ecosia|startpage|qwant|naver|seznam)\.[a-z.]+$|(^|\.)search\.brave\.com$/;
const SOCIAL =
  /(^|\.)(facebook\.com|fb\.com|fb\.me|instagram\.com|t\.co|twitter\.com|x\.com|linkedin\.com|lnkd\.in|reddit\.com|youtube\.com|youtu\.be|pinterest\.[a-z.]+|whatsapp\.com|wa\.me|telegram\.org|t\.me|quora\.com|threads\.net|tiktok\.com|medium\.com)$/;
const MAIL = /(^|\.)(mail\.google\.com|outlook\.live\.com|outlook\.office\.com|mail\.yahoo\.com)$/;

/** Host name only, lower-cased, without "www.". Null when unusable. */
export function referrerHost(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 2048) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    return /^[a-z0-9.-]{1,253}$/.test(host) ? host : null;
  } catch {
    return null;
  }
}

/**
 * Where a visit came from. UTM medium wins when present, because the
 * person who tagged the link knows better than a host-name guess.
 */
export function classifySource(host: string | null, utmMedium: string | null): ReferrerType {
  const medium = utmMedium?.toLowerCase() ?? "";
  if (/^(cpc|ppc|paid|paidsearch|paid_search|display|cpm|banner|paid_social|paidsocial)$/.test(medium)) return "paid";
  if (medium === "email" || medium === "newsletter") return "email";
  if (medium === "social" || medium === "social-network" || medium === "social_media") return "social";
  if (medium === "organic") return "search";
  if (!host) return medium ? "referral" : "direct";
  if (SEARCH.test(host)) return "search";
  if (SOCIAL.test(host)) return "social";
  if (MAIL.test(host)) return "email";
  return "referral";
}

/* ── campaign parameters ────────────────────────────────────────── */

export const UTM_KEYS = ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content"] as const;
export type Utm = Partial<Record<(typeof UTM_KEYS)[number], string>>;

export function sanitizeUtmValue(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim().toLowerCase().slice(0, 80);
  if (!value || value.includes("@")) return null;
  return /^[a-z0-9 ._+\-/:|]+$/.test(value) ? value : null;
}

export function sanitizeUtm(raw: unknown): Utm {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Utm = {};
  for (const key of UTM_KEYS) {
    const value = sanitizeUtmValue((raw as Record<string, unknown>)[key]);
    if (value) out[key] = value;
  }
  return out;
}

/* ── user agents ────────────────────────────────────────────────── */

const BOT =
  /bot\b|bot\/|crawl|spider|slurp|mediapartners|adsbot|facebookexternalhit|embedly|preview|headless|phantomjs|puppeteer|playwright|selenium|lighthouse|pagespeed|gtmetrix|pingdom|uptime|monitor|statuscake|curl\/|wget|python-|python\/|httpclient|okhttp|go-http|java\/|axios|node-fetch|undici|postman|insomnia|scrapy|render\/health/i;

/** Known automated clients, and any request with no plausible browser UA. */
export function isBot(userAgent: string | null | undefined): boolean {
  if (!userAgent || userAgent.length < 20 || userAgent.length > 1000) return true;
  if (!/mozilla\/|opera\//i.test(userAgent)) return true;
  return BOT.test(userAgent);
}

export type DeviceInfo = {
  device: "desktop" | "mobile" | "tablet";
  browser: string;
  os: string;
};

/**
 * Coarse labels from the user agent string. User agents are easy to fake
 * and iPads that request desktop sites report as macOS, so these are
 * distributions, not facts about any one visit.
 */
export function parseUserAgent(ua: string): DeviceInfo {
  const tablet = /ipad|tablet|kindle|silk|playbook|(android(?!.*mobile))/i.test(ua);
  const mobile = !tablet && /mobi|iphone|ipod|android.*mobile|windows phone|blackberry/i.test(ua);

  let browser = "Other";
  if (/edg(e|a|ios)?\//i.test(ua)) browser = "Edge";
  else if (/opr\/|opera/i.test(ua)) browser = "Opera";
  else if (/samsungbrowser\//i.test(ua)) browser = "Samsung Internet";
  else if (/firefox\/|fxios\//i.test(ua)) browser = "Firefox";
  else if (/chrome\/|crios\//i.test(ua)) browser = "Chrome";
  else if (/safari\//i.test(ua) && /version\//i.test(ua)) browser = "Safari";

  let os = "Other";
  if (/windows nt/i.test(ua)) os = "Windows";
  else if (/iphone|ipad|ipod/i.test(ua)) os = "iOS";
  else if (/android/i.test(ua)) os = "Android";
  else if (/cros/i.test(ua)) os = "ChromeOS";
  else if (/mac os x|macintosh/i.test(ua)) os = "macOS";
  else if (/linux/i.test(ua)) os = "Linux";

  return { device: tablet ? "tablet" : mobile ? "mobile" : "desktop", browser, os };
}

/* ── internal addresses ─────────────────────────────────────────── */

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let out = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    out = out * 256 + n;
  }
  return out;
}

/** An IPv4 or IPv6 address, or an IPv4 CIDR range like 203.0.113.0/24. */
export function isValidIpRule(rule: string): boolean {
  const [base, bits, extra] = rule.split("/");
  if (extra !== undefined) return false;
  if (ipv4ToInt(base) !== null) {
    return bits === undefined || (/^\d{1,2}$/.test(bits) && Number(bits) <= 32);
  }
  return bits === undefined && /^[0-9a-f:]{2,39}$/i.test(base) && base.includes(":");
}

export function ipMatchesRule(ip: string, rule: string): boolean {
  const clean = ip.replace(/^::ffff:/i, "");
  const [base, bits] = rule.split("/");
  const target = ipv4ToInt(clean);
  const network = ipv4ToInt(base);
  if (target !== null && network !== null) {
    const prefix = bits === undefined ? 32 : Number(bits);
    if (prefix === 0) return true;
    const mask = prefix === 32 ? 0xffffffff : (~((1 << (32 - prefix)) - 1)) >>> 0;
    return ((target & mask) >>> 0) === ((network & mask) >>> 0);
  }
  return clean.toLowerCase() === base.toLowerCase();
}

/** Two-letter country code from a header a trusted proxy sets, or null. */
export function sanitizeCountry(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const code = raw.trim().toUpperCase();
  return /^[A-Z]{2}$/.test(code) && code !== "XX" && code !== "T1" ? code : null;
}
