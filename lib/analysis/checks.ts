import type { IssuePriority, IssueStatus } from "@/lib/db/types";
import type { FeatureKey } from "@/lib/plans";
import type { PageAnalysis } from "./html";
import type {
  AdDensity,
  AdsTxtReport,
  AiEstimate,
  DuplicateReport,
  HumanEstimate,
  OriginalitySignals,
  SitemapReport,
  StructureReport,
} from "./signals";
import type { CategoryKey, Finding } from "./types";

/**
 * The check catalogue.
 *
 * Each entry is a pure function of a snapshot, so the whole audit is
 * deterministic and reviewable in one place.
 *
 * Every check declares the plan feature it belongs to. `runChecks` is
 * given the account's effective feature set and skips anything outside
 * it — so a line on the pricing page and a check in this file are the
 * same fact stated twice, and a feature nobody paid for costs nothing to
 * *not* compute. Checks with no `feature` are the base page read that
 * every plan, including Free, receives.
 */

export type PolicyKind =
  | "privacy"
  | "contact"
  | "about"
  | "terms"
  | "disclaimer"
  | "cookies";

export type SiteSnapshot = {
  input: string;
  origin: string;
  domain: string;
  home: PageAnalysis;
  /** Pages that returned a success status and could be read. */
  pages: PageAnalysis[];
  /** Pages we tried and could not read, kept out of the content averages. */
  failedPages: Array<{ url: string; status: number }>;
  /** Links whose text or path identifies a required page. */
  policyLinks: Partial<Record<PolicyKind, { url: string; label: string }>>;
  /** Fetched bodies for the required pages we could read. */
  policyPages: Partial<Record<PolicyKind, PageAnalysis>>;
  robots: {
    found: boolean;
    blocksAll: boolean;
    blocksAdsBot: boolean;
    sitemaps: string[];
  } | null;
  sitemapFound: boolean;
  https: boolean;
  httpRedirectsToHttps: boolean | null;
  brokenLinks: Array<{ url: string; status: number }>;
  sampledLinks: number;
  hasMailto: boolean;
  hasContactForm: boolean;
  internalUrls: string[];
  /* ── computed only when the matching feature is active ──────────── */
  /** Machine-written estimate over the sampled copy. */
  ai: AiEstimate | null;
  /** Human-authorship signals. */
  human: HumanEstimate | null;
  /** Boilerplate, syndication and duplicate composite. */
  originality: OriginalitySignals | null;
  /** Page-against-page overlap. */
  duplicates: DuplicateReport | null;
  /** Ad units against content volume. */
  ads: AdDensity | null;
  adsTxt: AdsTxtReport | null;
  /** Depth, orphans and sections. */
  structure: StructureReport | null;
  /** Parsed sitemap, when one was found and read. */
  sitemap: SitemapReport | null;
  /** Sampled sitemap URLs that did not answer. */
  sitemapUnreachable: string[];
};

type Outcome = {
  status: IssueStatus;
  detail: string;
  fix?: string;
  evidence?: string;
};

type CheckDef = {
  id: string;
  category: CategoryKey;
  label: string;
  weight: number;
  failPriority: IssuePriority;
  warnPriority: IssuePriority;
  /** The plan feature that buys this check. Undefined = every plan. */
  feature?: FeatureKey;
  run: (snapshot: SiteSnapshot) => Outcome;
};

const RESTRICTED_TERMS: Array<{ term: RegExp; topic: string }> = [
  { term: /\b(porn|pornographic|xxx|escort service|camgirl)\b/i, topic: "adult content" },
  { term: /\b(online casino|betting odds|satta matka|teen patti cash|poker for real money)\b/i, topic: "gambling" },
  { term: /\b(buy weed online|order cocaine|steroids for sale|research chemicals for sale)\b/i, topic: "illegal drugs" },
  { term: /\b(buy handgun|ammo for sale|silencer for sale|switchblade for sale)\b/i, topic: "weapons sales" },
  { term: /\b(crack keygen|nulled script|cracked apk download|free premium accounts)\b/i, topic: "pirated software" },
  { term: /\b(replica watches|first copy shoes|counterfeit currency)\b/i, topic: "counterfeit goods" },
  { term: /\b(write my essay for me|assignment writing service)\b/i, topic: "academic misconduct" },
  { term: /\b(miracle cure|guaranteed cancer cure|lose 20 kg in a week)\b/i, topic: "misleading health claims" },
];

const PLACEHOLDER_TERMS: Array<{ term: RegExp; label: string }> = [
  { term: /lorem ipsum/i, label: "Lorem ipsum filler" },
  { term: /\bunder construction\b/i, label: '"Under construction"' },
  { term: /\bcoming soon\b/i, label: '"Coming soon"' },
  { term: /just another wordpress site/i, label: "the default WordPress tagline" },
  { term: /\bhello world!\b/i, label: 'the default "Hello world!" post' },
  { term: /\byour (?:title|text|content) here\b/i, label: 'a "your content here" placeholder' },
  { term: /\bsample page\b/i, label: 'the default "Sample Page"' },
  { term: /\bthis is an example page\b/i, label: "example template copy" },
];

function pct(part: number, total: number): number {
  return total === 0 ? 0 : Math.round((part / total) * 100);
}

function list(values: string[], max = 3): string {
  const shown = values.slice(0, max);
  const rest = values.length - shown.length;
  return rest > 0 ? `${shown.join(", ")} and ${rest} more` : shown.join(", ");
}

/** A URL as a path, for evidence lines where the host is already known. */
function short(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.pathname === "/" ? "/" : parsed.pathname + parsed.search;
  } catch {
    return url;
  }
}

export const CHECKS: CheckDef[] = [
  // ── Content quality ──────────────────────────────────────────────
  {
    id: "cnt-depth",
    category: "content",
    label: "Page depth",
    weight: 5,
    failPriority: "high",
    warnPriority: "medium",
    run: (s) => {
      const counts = s.pages.map((page) => page.wordCount);
      const average = Math.round(
        counts.reduce((sum, n) => sum + n, 0) / Math.max(1, counts.length),
      );
      const evidence = `${average} words average across ${s.pages.length} page(s)`;
      if (average >= 700) {
        return { status: "pass", detail: `Pages average ${average} words — comfortably substantial.`, evidence };
      }
      if (average >= 350) {
        return {
          status: "warn",
          detail: `Pages average ${average} words. Reviewers read that as light.`,
          fix: "Aim for 700+ words on your main pages. Expand the thinnest ones first rather than adding new short posts.",
          evidence,
        };
      }
      return {
        status: "fail",
        detail: `Pages average only ${average} words. This is the single most common reason applications are rejected.`,
        fix: "Rewrite your main pages to 700–1,500 words of original, useful content before reapplying.",
        evidence,
      };
    },
  },
  {
    id: "cnt-thin",
    category: "content",
    label: "Thin pages",
    weight: 4,
    failPriority: "high",
    warnPriority: "medium",
    run: (s) => {
      const thin = s.pages.filter((page) => page.wordCount < 250);
      if (thin.length === 0) {
        return { status: "pass", detail: "No page we read falls under 250 words." };
      }
      const evidence = list(thin.map((page) => page.url));
      if (thin.length === 1) {
        return {
          status: "warn",
          detail: `One page is under 250 words.`,
          fix: "Expand it, merge it into a fuller page, or mark it noindex so reviewers do not count it.",
          evidence,
        };
      }
      return {
        status: "fail",
        detail: `${thin.length} of the ${s.pages.length} pages we read are under 250 words.`,
        fix: "Expand or remove the thin pages. A small site of strong pages outperforms a large one of stubs.",
        evidence,
      };
    },
  },
  {
    id: "cnt-breadth",
    category: "content",
    label: "Site breadth",
    weight: 4,
    failPriority: "high",
    warnPriority: "medium",
    run: (s) => {
      const total = s.internalUrls.length;
      const evidence = `${total} distinct internal URLs linked`;
      if (total >= 15) {
        return { status: "pass", detail: `${total} internal pages are linked from the site.`, evidence };
      }
      if (total >= 6) {
        return {
          status: "warn",
          detail: `Only ${total} internal pages are linked. That is a thin catalogue.`,
          fix: "Publish more before applying — most approved sites have 15+ real pages.",
          evidence,
        };
      }
      return {
        status: "fail",
        detail: `Only ${total} internal page(s) are linked. There is not enough here to review.`,
        fix: "Build out to at least 15 substantial pages, then apply.",
        evidence,
      };
    },
  },
  {
    id: "cnt-duplicate-titles",
    category: "content",
    label: "Duplicate titles",
    weight: 3,
    failPriority: "medium",
    warnPriority: "low",
    run: (s) => {
      const seen = new Map<string, number>();
      for (const page of s.pages) {
        const key = page.title.trim().toLowerCase();
        if (!key) continue;
        seen.set(key, (seen.get(key) ?? 0) + 1);
      }
      const dupes = [...seen.entries()].filter(([, count]) => count > 1);
      if (dupes.length === 0) {
        return { status: "pass", detail: "Every page we read has its own title." };
      }
      return {
        status: "warn",
        detail: `${dupes.length} title(s) are reused across pages, which reads as duplicated content.`,
        fix: "Give each page a distinct, descriptive title tag.",
        evidence: list(dupes.map(([title]) => `"${title}"`)),
      };
    },
  },
  {
    id: "cnt-h1",
    category: "content",
    label: "Single H1 per page",
    weight: 3,
    failPriority: "medium",
    warnPriority: "low",
    run: (s) => {
      const bad = s.pages.filter((page) => page.headings1.length !== 1);
      if (bad.length === 0) {
        return { status: "pass", detail: "Each page has exactly one H1." };
      }
      const missing = bad.filter((page) => page.headings1.length === 0).length;
      return {
        status: "warn",
        detail:
          missing > 0
            ? `${missing} page(s) have no H1 heading at all.`
            : `${bad.length} page(s) use more than one H1.`,
        fix: "Use one H1 per page for its main title, and H2s for sections beneath it.",
        evidence: list(bad.map((page) => page.url)),
      };
    },
  },
  {
    id: "cnt-structure",
    category: "content",
    label: "Heading structure",
    weight: 2,
    failPriority: "low",
    warnPriority: "low",
    run: (s) => {
      const long = s.pages.filter((page) => page.wordCount >= 500);
      if (long.length === 0) {
        return {
          status: "warn",
          detail: "No page is long enough to judge its heading structure.",
          fix: "Once pages pass 500 words, break them up with H2 subheadings.",
        };
      }
      const unstructured = long.filter((page) => page.headings2.length < 2);
      if (unstructured.length === 0) {
        return { status: "pass", detail: "Long pages are broken up with subheadings." };
      }
      return {
        status: "warn",
        detail: `${unstructured.length} long page(s) run without subheadings.`,
        fix: "Add H2s every few hundred words so pages scan easily.",
        evidence: list(unstructured.map((page) => page.url)),
      };
    },
  },
  {
    id: "cnt-restricted",
    category: "content",
    label: "Restricted topics",
    weight: 6,
    failPriority: "high",
    warnPriority: "high",
    run: (s) => {
      const corpus = s.pages.map((page) => page.text).join(" \n ");
      const hits = RESTRICTED_TERMS.filter(({ term }) => term.test(corpus)).map(
        ({ topic }) => topic,
      );
      const topics = [...new Set(hits)];
      if (topics.length === 0) {
        return {
          status: "pass",
          detail: "No signals of content AdSense prohibits.",
        };
      }
      if (topics.length >= 2) {
        return {
          status: "fail",
          detail: `Language associated with ${list(topics)} appears on the site. AdSense declines these outright.`,
          fix: "Remove the content, or accept that this domain will not be eligible.",
          evidence: topics.join(", "),
        };
      }
      return {
        status: "warn",
        detail: `Wording associated with ${topics[0]} appears somewhere on the site.`,
        fix: "Read the flagged pages. If the topic is incidental, rephrase; if it is the subject, this domain is not eligible.",
        evidence: topics.join(", "),
      };
    },
  },
  {
    id: "cnt-placeholder",
    category: "content",
    label: "Placeholder content",
    weight: 4,
    failPriority: "high",
    warnPriority: "medium",
    run: (s) => {
      const corpus = s.pages.map((page) => `${page.title} ${page.text}`).join(" \n ");
      const hits = PLACEHOLDER_TERMS.filter(({ term }) => term.test(corpus)).map(
        ({ label }) => label,
      );
      if (hits.length === 0) {
        return { status: "pass", detail: "No template or placeholder text left behind." };
      }
      if (hits.length >= 2) {
        return {
          status: "fail",
          detail: `The site still shows ${list(hits)}. Reviewers treat an unfinished site as an automatic no.`,
          fix: "Delete every default post, page and tagline your theme shipped with.",
          evidence: hits.join("; "),
        };
      }
      return {
        status: "warn",
        detail: `The site still shows ${hits[0]}.`,
        fix: "Remove it before applying.",
        evidence: hits.join("; "),
      };
    },
  },
  {
    id: "cnt-lang",
    category: "content",
    label: "Declared language",
    weight: 2,
    failPriority: "low",
    warnPriority: "low",
    run: (s) =>
      s.home.lang
        ? { status: "pass", detail: `The page declares lang="${s.home.lang}".` }
        : {
            status: "warn",
            detail: "The <html> element has no lang attribute.",
            fix: 'Add lang="en" (or your language) to the <html> tag.',
          },
  },

  // ── Privacy & legal ──────────────────────────────────────────────
  {
    id: "pvl-privacy",
    category: "privacy",
    label: "Privacy policy",
    weight: 8,
    failPriority: "high",
    warnPriority: "high",
    run: (s) => {
      const hit = s.policyLinks.privacy;
      if (!hit) {
        return {
          status: "fail",
          detail: "No privacy policy found. This is a hard requirement — applications without one are declined.",
          fix: "Publish a privacy policy covering cookies, third-party advertising and data collection, and link it from every page.",
        };
      }
      return {
        status: "pass",
        detail: `Privacy policy found and linked as "${hit.label}".`,
        evidence: hit.url,
      };
    },
  },
  {
    id: "pvl-privacy-ads",
    category: "privacy",
    label: "Advertising disclosure",
    weight: 5,
    failPriority: "high",
    warnPriority: "medium",
    run: (s) => {
      const page = s.policyPages.privacy;
      if (!s.policyLinks.privacy) {
        return {
          status: "fail",
          detail: "There is no privacy policy to disclose ad behaviour in.",
          fix: "Publish a privacy policy first.",
        };
      }
      if (!page) {
        return {
          status: "warn",
          detail: "We found the privacy policy link but could not read the page to check its contents.",
          fix: "Make sure the privacy policy loads for anonymous visitors.",
        };
      }
      const text = page.text.toLowerCase();
      const mentionsCookies = /cookie/.test(text);
      const mentionsAds = /(advertis|third.?part|google|dart|personali[sz]ed ads)/.test(text);
      if (mentionsCookies && mentionsAds) {
        return {
          status: "pass",
          detail: "The policy covers cookies and third-party advertising.",
          evidence: `${page.wordCount} words`,
        };
      }
      return {
        status: "warn",
        detail: `The privacy policy does not clearly mention ${!mentionsCookies ? "cookies" : "third-party advertising"}.`,
        fix: "State that third parties, including Google, may set cookies to serve ads, and how visitors can opt out.",
        evidence: page.url,
      };
    },
  },
  {
    id: "pvl-contact",
    category: "privacy",
    label: "Contact route",
    weight: 6,
    failPriority: "high",
    warnPriority: "medium",
    run: (s) => {
      if (s.policyLinks.contact) {
        return {
          status: "pass",
          detail: `Contact page found at "${s.policyLinks.contact.label}".`,
          evidence: s.policyLinks.contact.url,
        };
      }
      if (s.hasContactForm || s.hasMailto) {
        return {
          status: "warn",
          detail: s.hasMailto
            ? "There is an email link but no dedicated contact page."
            : "There is a form but no dedicated contact page.",
          fix: "Add a /contact page with a real way to reach you. Reviewers look for it by name.",
        };
      }
      return {
        status: "fail",
        detail: "No contact page, form or email address anywhere on the site. Reviewers treat this as a blocker.",
        fix: "Publish a contact page with an email address or form and link it from the footer.",
      };
    },
  },
  {
    id: "pvl-about",
    category: "privacy",
    label: "About page",
    weight: 4,
    failPriority: "medium",
    warnPriority: "medium",
    run: (s) =>
      s.policyLinks.about
        ? {
            status: "pass",
            detail: `About page found at "${s.policyLinks.about.label}".`,
            evidence: s.policyLinks.about.url,
          }
        : {
            status: "fail",
            detail: "No About page. Reviewers want to know who publishes the site.",
            fix: "Write an About page naming the author or organisation, with a short, real biography.",
          },
  },
  {
    id: "pvl-terms",
    category: "privacy",
    label: "Terms or disclaimer",
    weight: 3,
    failPriority: "medium",
    warnPriority: "low",
    run: (s) => {
      const hit = s.policyLinks.terms ?? s.policyLinks.disclaimer;
      return hit
        ? { status: "pass", detail: `Found "${hit.label}".`, evidence: hit.url }
        : {
            status: "warn",
            detail: "No terms of service or disclaimer page.",
            fix: "Add one. It is quick, and its absence stands out on an otherwise complete site.",
          };
    },
  },
  {
    id: "pvl-cookie-notice",
    category: "privacy",
    label: "Cookie notice",
    weight: 2,
    failPriority: "low",
    warnPriority: "low",
    run: (s) => {
      const markup = `${s.home.text} ${JSON.stringify(s.home.links.map((link) => link.text))}`;
      const hasNotice =
        /(cookie (?:policy|notice|consent|settings)|we use cookies|accept cookies|manage (?:cookies|consent))/i.test(
          markup,
        ) || Boolean(s.policyLinks.cookies);
      return hasNotice
        ? { status: "pass", detail: "A cookie or consent notice is present." }
        : {
            status: "warn",
            detail: "No cookie consent notice detected.",
            fix: "Add a consent banner if you serve visitors in the EU or UK — it will be required once ads run.",
          };
    },
  },

  // ── SEO ──────────────────────────────────────────────────────────
  {
    id: "seo-title",
    category: "seo",
    label: "Title tags",
    weight: 5,
    failPriority: "medium",
    warnPriority: "low",
    run: (s) => {
      const missing = s.pages.filter((page) => !page.title.trim());
      if (missing.length > 0) {
        return {
          status: "fail",
          detail: `${missing.length} page(s) have no title tag.`,
          fix: "Give every page a unique title of roughly 50–60 characters.",
          evidence: list(missing.map((page) => page.url)),
        };
      }
      const awkward = s.pages.filter(
        (page) => page.title.length < 15 || page.title.length > 65,
      );
      if (awkward.length > 0) {
        return {
          status: "warn",
          detail: `${awkward.length} title(s) are outside the 15–65 character range search results show.`,
          fix: "Rewrite them to be descriptive but short enough not to truncate.",
          evidence: list(awkward.map((page) => `${page.title.length} chars: ${page.url}`)),
        };
      }
      return { status: "pass", detail: "Every page has a well-sized title tag." };
    },
  },
  {
    id: "seo-description",
    category: "seo",
    label: "Meta descriptions",
    weight: 4,
    failPriority: "medium",
    warnPriority: "low",
    run: (s) => {
      const missing = s.pages.filter((page) => !page.metaDescription.trim());
      if (missing.length === 0) {
        return { status: "pass", detail: "Every page we read has a meta description." };
      }
      if (missing.length === s.pages.length) {
        return {
          status: "fail",
          detail: "No page has a meta description.",
          fix: "Write a 120–155 character summary for each page.",
        };
      }
      return {
        status: "warn",
        detail: `${missing.length} of ${s.pages.length} pages have no meta description.`,
        fix: "Add a 120–155 character summary to each of them.",
        evidence: list(missing.map((page) => page.url)),
      };
    },
  },
  {
    id: "seo-canonical",
    category: "seo",
    label: "Canonical URLs",
    weight: 3,
    failPriority: "low",
    warnPriority: "low",
    run: (s) => {
      const missing = s.pages.filter((page) => !page.canonical);
      if (missing.length === 0) {
        return { status: "pass", detail: "Canonical URLs are declared." };
      }
      return {
        status: "warn",
        detail: `${missing.length} of ${s.pages.length} pages declare no canonical URL.`,
        fix: "Add <link rel=\"canonical\"> so duplicate URLs do not compete.",
        evidence: list(missing.map((page) => page.url)),
      };
    },
  },
  {
    id: "seo-noindex",
    category: "seo",
    label: "Indexing allowed",
    weight: 5,
    failPriority: "high",
    warnPriority: "medium",
    run: (s) => {
      const blocked = s.pages.filter((page) => /noindex/.test(page.metaRobots));
      if (blocked.length === 0) {
        return { status: "pass", detail: "No page asks search engines to skip it." };
      }
      const homeBlocked = blocked.some((page) => page.url === s.home.url);
      return {
        status: homeBlocked ? "fail" : "warn",
        detail: homeBlocked
          ? "The homepage carries a noindex directive, so it cannot be reviewed."
          : `${blocked.length} page(s) carry noindex.`,
        fix: "Remove the noindex meta tag from pages you want reviewed and indexed.",
        evidence: list(blocked.map((page) => page.url)),
      };
    },
  },
  {
    id: "seo-og",
    category: "seo",
    label: "Social preview tags",
    weight: 2,
    failPriority: "low",
    warnPriority: "low",
    run: (s) => {
      const hasTitle = Boolean(s.home.ogTitle);
      const hasImage = Boolean(s.home.ogImage);
      if (hasTitle && hasImage) {
        return { status: "pass", detail: "Open Graph title and image are set." };
      }
      return {
        status: "warn",
        detail: `Open Graph ${!hasTitle && !hasImage ? "tags are" : !hasTitle ? "title is" : "image is"} missing.`,
        fix: "Add og:title, og:description and og:image so shared links render properly.",
      };
    },
  },
  {
    id: "seo-alt",
    category: "seo",
    label: "Image alt text",
    weight: 3,
    failPriority: "medium",
    warnPriority: "low",
    run: (s) => {
      const images = s.pages.flatMap((page) => page.images);
      if (images.length === 0) {
        return {
          status: "warn",
          detail: "No images found, so there is nothing to describe.",
          fix: "Original images help; give each one descriptive alt text when you add them.",
        };
      }
      const described = images.filter((image) => (image.alt ?? "").trim().length > 0);
      const share = pct(described.length, images.length);
      if (share >= 85) {
        return {
          status: "pass",
          detail: `${share}% of ${images.length} images have alt text.`,
        };
      }
      return {
        status: share >= 50 ? "warn" : "fail",
        detail: `Only ${share}% of ${images.length} images have alt text.`,
        fix: "Describe each meaningful image. It is an accessibility requirement as much as an SEO one.",
      };
    },
  },

  // ── Navigation ───────────────────────────────────────────────────
  {
    id: "nav-menu",
    category: "navigation",
    label: "Primary navigation",
    weight: 4,
    failPriority: "high",
    warnPriority: "medium",
    run: (s) => {
      if (s.home.hasNavElement) {
        return { status: "pass", detail: "The homepage has a marked-up navigation region." };
      }
      const internal = s.home.links.filter((link) => link.internal).length;
      if (internal >= 5) {
        return {
          status: "warn",
          detail: "There is no <nav> element, though internal links are present.",
          fix: "Wrap your menu in <nav> so crawlers and screen readers recognise it.",
        };
      }
      return {
        status: "fail",
        detail: "No navigation menu found on the homepage.",
        fix: "Add a header menu linking your main sections.",
      };
    },
  },
  {
    id: "nav-internal",
    category: "navigation",
    label: "Internal linking",
    weight: 4,
    failPriority: "medium",
    warnPriority: "low",
    run: (s) => {
      const internal = new Set(
        s.home.links.filter((link) => link.internal && link.absolute).map((link) => link.absolute),
      ).size;
      if (internal >= 8) {
        return { status: "pass", detail: `The homepage links to ${internal} internal pages.` };
      }
      if (internal >= 4) {
        return {
          status: "warn",
          detail: `The homepage links to only ${internal} internal pages.`,
          fix: "Surface more of your content from the homepage so reviewers and crawlers find it.",
        };
      }
      return {
        status: "fail",
        detail: `The homepage links to just ${internal} internal page(s), so the rest of the site is hard to reach.`,
        fix: "Link your main sections and recent posts from the homepage.",
      };
    },
  },
  {
    id: "nav-footer",
    category: "navigation",
    label: "Footer links",
    weight: 3,
    failPriority: "medium",
    warnPriority: "low",
    run: (s) => {
      if (!s.home.hasFooterElement) {
        return {
          status: "warn",
          detail: "No footer region found on the homepage.",
          fix: "Add a footer and put your privacy, contact and about links in it — that is where reviewers look.",
        };
      }
      const required: PolicyKind[] = ["privacy", "contact", "about"];
      const present = required.filter((kind) => s.policyLinks[kind]);
      if (present.length === required.length) {
        return { status: "pass", detail: "Footer carries the privacy, contact and about links." };
      }
      const missing = required.filter((kind) => !s.policyLinks[kind]);
      return {
        status: "warn",
        detail: `The footer is missing ${list(missing)} link(s).`,
        fix: "Link every required page from the footer of every page.",
      };
    },
  },
  {
    id: "nav-broken",
    category: "navigation",
    label: "Broken links",
    weight: 4,
    failPriority: "medium",
    warnPriority: "low",
    run: (s) => {
      if (s.sampledLinks === 0) {
        return {
          status: "warn",
          detail: "There were no internal links to test.",
          fix: "Add internal links between your pages.",
        };
      }
      if (s.brokenLinks.length === 0) {
        return {
          status: "pass",
          detail: `All ${s.sampledLinks} internal links we sampled resolve.`,
        };
      }
      const share = pct(s.brokenLinks.length, s.sampledLinks);
      return {
        status: share > 20 ? "fail" : "warn",
        detail: `${s.brokenLinks.length} of ${s.sampledLinks} sampled internal links are broken.`,
        fix: "Fix or remove them. Dead links on a small site read as neglect.",
        evidence: list(s.brokenLinks.map((link) => `${link.status} ${link.url}`)),
      };
    },
  },

  // ── Mobile experience ────────────────────────────────────────────
  {
    id: "mob-viewport",
    category: "mobile",
    label: "Responsive viewport",
    weight: 6,
    failPriority: "high",
    warnPriority: "medium",
    run: (s) => {
      const missing = s.pages.filter((page) => !page.viewport);
      if (missing.length === s.pages.length) {
        return {
          status: "fail",
          detail: "No viewport meta tag, so phones render the desktop layout zoomed out.",
          fix: 'Add <meta name="viewport" content="width=device-width, initial-scale=1"> to every page.',
        };
      }
      if (missing.length > 0) {
        return {
          status: "warn",
          detail: `${missing.length} page(s) have no viewport meta tag.`,
          fix: "Add the viewport tag to your base template so every page inherits it.",
          evidence: list(missing.map((page) => page.url)),
        };
      }
      const wrong = s.pages.filter((page) => !/width\s*=\s*device-width/i.test(page.viewport));
      if (wrong.length > 0) {
        return {
          status: "warn",
          detail: "The viewport tag does not set width=device-width.",
          fix: 'Use content="width=device-width, initial-scale=1".',
        };
      }
      return { status: "pass", detail: "Viewport is set for device width on every page." };
    },
  },
  {
    id: "mob-zoom",
    category: "mobile",
    label: "Pinch zoom",
    weight: 3,
    failPriority: "medium",
    warnPriority: "medium",
    run: (s) => {
      const blocking = s.pages.filter((page) => page.blocksZoom);
      if (blocking.length === 0) {
        return { status: "pass", detail: "Visitors can zoom." };
      }
      return {
        status: "warn",
        detail: `${blocking.length} page(s) disable pinch zoom.`,
        fix: "Drop user-scalable=no and maximum-scale=1 — blocking zoom is an accessibility failure.",
        evidence: list(blocking.map((page) => page.url)),
      };
    },
  },
  {
    id: "mob-fixed-width",
    category: "mobile",
    label: "Fixed-width elements",
    weight: 4,
    failPriority: "medium",
    warnPriority: "low",
    run: (s) => {
      const offenders = s.pages.filter((page) => page.wideFixedWidths.length > 0);
      if (offenders.length === 0) {
        return { status: "pass", detail: "No hard-coded widths wide enough to overflow a phone." };
      }
      const widest = Math.max(...offenders.flatMap((page) => page.wideFixedWidths));
      return {
        status: widest > 900 ? "fail" : "warn",
        detail: `Fixed widths up to ${widest}px appear in the markup, which will overflow a 360px screen.`,
        fix: "Replace fixed pixel widths with max-width and percentage or flexible units.",
        evidence: list(offenders.map((page) => `${page.wideFixedWidths[0]}px on ${page.url}`)),
      };
    },
  },

  // ── Technical health ─────────────────────────────────────────────
  {
    id: "tec-https",
    category: "technical",
    label: "HTTPS",
    weight: 7,
    failPriority: "high",
    warnPriority: "high",
    run: (s) =>
      s.https
        ? { status: "pass", detail: "The site serves over HTTPS with a certificate we could validate." }
        : {
            status: "fail",
            detail: "The site does not serve over HTTPS.",
            fix: "Install a certificate — Let's Encrypt is free, and most hosts do it in one click.",
          },
  },
  {
    id: "tec-http-redirect",
    category: "technical",
    label: "HTTP redirect",
    weight: 4,
    failPriority: "medium",
    warnPriority: "low",
    run: (s) => {
      if (s.httpRedirectsToHttps === true) {
        return { status: "pass", detail: "Plain HTTP redirects to HTTPS." };
      }
      if (s.httpRedirectsToHttps === null) {
        return {
          status: "warn",
          detail: "We could not confirm whether HTTP redirects to HTTPS.",
          fix: "Check that http:// requests 301 to https://.",
        };
      }
      return {
        status: "warn",
        detail: "Plain HTTP does not redirect to HTTPS, so the insecure version stays reachable.",
        fix: "Add a permanent redirect from http:// to https:// for every path.",
      };
    },
  },
  {
    id: "tec-robots",
    category: "technical",
    label: "Crawler access",
    weight: 5,
    failPriority: "high",
    warnPriority: "medium",
    run: (s) => {
      if (!s.robots || !s.robots.found) {
        return {
          status: "warn",
          detail: "No robots.txt found. Crawling is allowed by default, but the file is worth having.",
          fix: "Add a robots.txt that allows crawling and points at your sitemap.",
        };
      }
      if (s.robots.blocksAll) {
        return {
          status: "fail",
          detail: "robots.txt blocks all crawlers, so Google cannot review the site.",
          fix: "Remove the blanket Disallow: / rule.",
        };
      }
      if (s.robots.blocksAdsBot) {
        return {
          status: "fail",
          detail: "robots.txt blocks Google's ad crawler (Mediapartners-Google).",
          fix: "Allow Mediapartners-Google explicitly — without it ads cannot be served.",
        };
      }
      return { status: "pass", detail: "robots.txt allows Google and the AdSense crawler." };
    },
  },
  {
    id: "tec-sitemap",
    category: "technical",
    label: "Sitemap",
    weight: 3,
    failPriority: "low",
    warnPriority: "low",
    run: (s) =>
      s.sitemapFound
        ? { status: "pass", detail: "A sitemap is reachable." }
        : {
            status: "warn",
            detail: "No sitemap found at the usual paths or in robots.txt.",
            fix: "Publish /sitemap.xml and reference it from robots.txt.",
          },
  },
  {
    id: "tec-speed",
    category: "technical",
    label: "Response time",
    weight: 3,
    failPriority: "medium",
    warnPriority: "low",
    run: (s) => {
      const ms = s.home.ms;
      if (ms <= 1_200) {
        return { status: "pass", detail: `The homepage responded in ${ms} ms.` };
      }
      if (ms <= 3_000) {
        return {
          status: "warn",
          detail: `The homepage took ${ms} ms to respond.`,
          fix: "Enable caching and compression, and consider a CDN.",
        };
      }
      return {
        status: "fail",
        detail: `The homepage took ${ms} ms to respond, which is slow enough to hurt both visitors and review.`,
        fix: "Investigate hosting, caching and image sizes before applying.",
      };
    },
  },
  {
    id: "tec-status",
    category: "technical",
    label: "Server responses",
    weight: 4,
    failPriority: "high",
    warnPriority: "medium",
    run: (s) => {
      const bad = s.failedPages.filter((page) => page.status >= 400 || page.status === 0);
      if (bad.length === 0) {
        return { status: "pass", detail: `All ${s.pages.length} page(s) returned a success status.` };
      }
      const server = bad.filter((page) => page.status >= 500);
      return {
        status: "fail",
        detail:
          server.length > 0
            ? `${server.length} page(s) returned a server error.`
            : `${bad.length} linked page(s) could not be loaded.`,
        fix: "Fix the failing routes — reviewers will hit them too.",
        evidence: list(bad.map((page) => `${page.status || "no response"} ${page.url}`)),
      };
    },
  },

  /* ══════════════════════════════════════════════════════════════════
   *  BASIC — AI content check
   * ════════════════════════════════════════════════════════════════ */
  {
    id: "cnt-ai-estimate",
    category: "content",
    label: "Machine-written estimate",
    weight: 5,
    failPriority: "medium",
    warnPriority: "medium",
    feature: "ai_content_check",
    run: (s) => {
      const ai = s.ai;
      if (!ai || !ai.reliable) {
        return {
          status: "warn",
          detail:
            "There was not enough prose on the pages we read to estimate anything from. This is a signal about sample size, not about your writing.",
          fix: "Publish longer articles — 500 words or more gives the estimate something to work with.",
        };
      }
      // Wording matters here: this is a signal, and the copy says so
      // every time. No number from this file is a determination of who
      // or what wrote a page.
      const preamble = `Estimated ${ai.score}/100 on our machine-written signal (${ai.band}), from ${ai.sampleWords} words. This is an estimate from writing-style patterns, not a determination of authorship.`;
      if (ai.band === "low") {
        return {
          status: "pass",
          detail: `${preamble} Nothing here reads as obviously generated.`,
          evidence: ai.reasons.join(" "),
        };
      }
      if (ai.band === "moderate") {
        return {
          status: "warn",
          detail: `${preamble}`,
          fix: "Add specifics only you could write — your own examples, numbers, screenshots and opinions. AdSense reviews value original value-add, not authorship provenance.",
          evidence: ai.reasons.join(" "),
        };
      }
      return {
        status: "fail",
        detail: `${preamble}`,
        fix: "Rewrite the strongest offenders in your own voice and cut the stock connectives. Reviewers look for content that adds something a reader cannot get elsewhere.",
        evidence: ai.reasons.join(" "),
      };
    },
  },

  /* ══════════════════════════════════════════════════════════════════
   *  BASIC — Content originality check
   * ════════════════════════════════════════════════════════════════ */
  {
    id: "cnt-originality",
    category: "content",
    label: "Originality signals",
    weight: 5,
    failPriority: "high",
    warnPriority: "medium",
    feature: "originality_check",
    run: (s) => {
      const o = s.originality;
      if (!o) {
        return { status: "warn", detail: "Originality signals were not computed for this run." };
      }
      const found = [...o.boilerplate, ...o.syndication];
      // Stated plainly: this is not a plagiarism check. No corpus is
      // consulted, so no claim about copying elsewhere is made.
      const scope =
        "We look for template filler, stock phrasing and syndication markers in the pages we read. We do not compare your text against the wider web, so this is not a plagiarism check.";
      if (found.length === 0 && o.score >= 80) {
        return {
          status: "pass",
          detail: `No template filler or syndication markers found. Originality signal ${o.score}/100. ${scope}`,
          evidence: o.notes.join(" ") || undefined,
        };
      }
      if (o.score >= 55) {
        return {
          status: "warn",
          detail: `Originality signal ${o.score}/100. ${found.length > 0 ? `We found ${list(found, 4)}.` : ""} ${scope}`,
          fix: "Replace the flagged passages with copy written for this site. Where content is syndicated, add your own commentary around it.",
          evidence: o.notes.join(" ") || undefined,
        };
      }
      return {
        status: "fail",
        detail: `Originality signal ${o.score}/100. We found ${list(found, 4)}. ${scope}`,
        fix: "Rewrite or remove the template and syndicated passages. A site built largely from other people's text is the most common reason an application is declined.",
        evidence: o.notes.join(" ") || undefined,
      };
    },
  },

  /* ══════════════════════════════════════════════════════════════════
   *  BASIC — Duplicate content check
   * ════════════════════════════════════════════════════════════════ */
  {
    id: "cnt-duplicate-pages",
    category: "content",
    label: "Duplicate and near-duplicate pages",
    weight: 5,
    failPriority: "high",
    warnPriority: "medium",
    feature: "duplicate_content_check",
    run: (s) => {
      const d = s.duplicates;
      if (!d || d.comparable < 2) {
        return {
          status: "warn",
          detail:
            "We need at least two pages of 120 words or more to compare. Only " +
            `${d?.comparable ?? 0} of the pages we read qualified.`,
          fix: "Publish more substantial pages so we can compare them against each other.",
        };
      }
      if (d.pairs.length === 0) {
        return {
          status: "pass",
          detail: `We compared all ${d.comparable} substantial pages against each other by overlapping seven-word sequences. None overlapped enough to be a duplicate.`,
        };
      }
      const exact = d.pairs.filter((pair) => pair.kind === "duplicate");
      const evidence = list(
        d.pairs.map((pair) => `${pair.overlap}% ${short(pair.a)} ≈ ${short(pair.b)}`),
        4,
      );
      if (exact.length > 0) {
        return {
          status: "fail",
          detail: `${exact.length} pair(s) of pages are effectively the same text (${exact[0]?.overlap}% overlap on the closest pair), out of ${d.comparable} compared.`,
          fix: "Consolidate the duplicates into one page and redirect the rest, or set a canonical tag pointing at the version you want indexed.",
          evidence,
        };
      }
      return {
        status: "warn",
        detail: `${d.pairs.length} pair(s) of pages are near-duplicates of each other, sharing ${d.pairs[0]?.overlap}% of their seven-word sequences at the closest.`,
        fix: "Differentiate the overlapping pages, or merge them. Reviewers reading two near-identical articles see one article twice.",
        evidence,
      };
    },
  },

  /* ══════════════════════════════════════════════════════════════════
   *  PRO — Advanced AI + human content check
   * ════════════════════════════════════════════════════════════════ */
  {
    id: "cnt-human-signals",
    category: "content",
    label: "Human authorship signals",
    weight: 4,
    failPriority: "medium",
    warnPriority: "low",
    feature: "ai_human_content_check",
    run: (s) => {
      const h = s.human;
      if (!h) {
        return { status: "warn", detail: "Authorship signals were not computed for this run." };
      }
      const present = h.present.length > 0 ? `We found ${list(h.present, 4)}.` : "";
      if (h.score >= 65) {
        return {
          status: "pass",
          detail: `${present} Together these are the marks reviewers look for when deciding whether a real person stands behind the site.`,
          evidence: `Authorship signal ${h.score}/100`,
        };
      }
      if (h.score >= 35) {
        return {
          status: "warn",
          detail: `${present} Still missing: ${list(h.missing, 3)}.`,
          fix: "Add a named author with a short bio, and a visible published or updated date on each article.",
          evidence: `Authorship signal ${h.score}/100`,
        };
      }
      return {
        status: "fail",
        detail: `Almost no authorship evidence on the pages we read. Missing: ${list(h.missing, 4)}.`,
        fix: "Add author bylines with real bios, published dates, and an about page that says who runs the site. An anonymous site with undated posts is read as low-value regardless of the writing.",
        evidence: `Authorship signal ${h.score}/100`,
      };
    },
  },

  /* ══════════════════════════════════════════════════════════════════
   *  PRO — Website structure analysis
   * ════════════════════════════════════════════════════════════════ */
  {
    id: "nav-depth",
    category: "navigation",
    label: "Site depth and sections",
    weight: 4,
    failPriority: "medium",
    warnPriority: "low",
    feature: "site_structure_analysis",
    run: (s) => {
      const st = s.structure;
      if (!st) {
        return { status: "warn", detail: "Structure was not analysed for this run." };
      }
      const sections =
        st.sections.length > 0 ? ` Top-level sections: ${list(st.sections, 6)}.` : "";
      if (st.maxDepth === 0 && s.internalUrls.length <= 1) {
        return {
          status: "fail",
          detail: "Every link we found points back at the homepage — there is no site structure to speak of.",
          fix: "Publish pages under clear sections and link to them from the homepage.",
        };
      }
      if (st.maxDepth > 5) {
        return {
          status: "warn",
          detail: `Pages sit up to ${st.maxDepth} directories deep (average ${st.averageDepth}).${sections}`,
          fix: "Flatten the deepest paths. Anything more than three or four levels down is hard for both readers and crawlers to reach.",
        };
      }
      return {
        status: "pass",
        detail: `Content sits at most ${st.maxDepth} directories deep (average ${st.averageDepth}), with ${st.hubLinks} internal links from the homepage.${sections}`,
      };
    },
  },
  {
    id: "nav-orphans",
    category: "navigation",
    label: "Orphan pages",
    weight: 3,
    failPriority: "medium",
    warnPriority: "low",
    feature: "site_structure_analysis",
    run: (s) => {
      const st = s.structure;
      if (!st) {
        return { status: "warn", detail: "Structure was not analysed for this run." };
      }
      if (st.orphans.length === 0) {
        return {
          status: "pass",
          detail: "Every page we read is linked from at least one other page we read.",
        };
      }
      return {
        status: "warn",
        detail: `${st.orphans.length} page(s) we reached are not linked from any other page in the crawl.`,
        fix: "Link these from a menu, an index page or a related-posts block so readers and crawlers can find them.",
        evidence: list(st.orphans.map(short), 4),
      };
    },
  },

  /* ══════════════════════════════════════════════════════════════════
   *  PRO — Crawlability / indexability
   * ════════════════════════════════════════════════════════════════ */
  {
    id: "tec-crawlability",
    category: "technical",
    label: "Crawlability and indexability",
    weight: 5,
    failPriority: "high",
    warnPriority: "medium",
    feature: "crawlability_check",
    run: (s) => {
      const problems: string[] = [];
      if (s.robots?.blocksAll) problems.push("robots.txt disallows all crawling at the root");
      if (s.robots?.blocksAdsBot) {
        problems.push("robots.txt blocks Mediapartners-Google or AdsBot-Google");
      }

      const noindex = s.pages.filter((page) => /noindex/i.test(page.metaRobots));
      if (noindex.length > 0) {
        problems.push(`${noindex.length} page(s) carry a noindex directive`);
      }

      const crossCanonical = s.pages.filter((page) => {
        if (!page.canonical) return false;
        try {
          const target = new URL(page.canonical, page.url);
          return target.hostname.replace(/^www\./, "") !== s.domain.replace(/^www\./, "");
        } catch {
          return false;
        }
      });
      if (crossCanonical.length > 0) {
        problems.push(
          `${crossCanonical.length} page(s) canonicalise to a different domain, which tells Google they are copies`,
        );
      }

      if (problems.length === 0) {
        return {
          status: "pass",
          detail: `Nothing blocks review: no blanket robots.txt disallow, no noindex on the ${s.pages.length} page(s) we read, and every canonical points within your own domain.`,
        };
      }

      const blocking = s.robots?.blocksAll || s.robots?.blocksAdsBot || crossCanonical.length > 0;
      return {
        status: blocking ? "fail" : "warn",
        detail: `${problems.length} crawl or index problem(s): ${problems.join("; ")}.`,
        fix: "Allow Googlebot, Mediapartners-Google and AdsBot-Google in robots.txt, remove noindex from pages you want reviewed, and canonicalise to your own URLs.",
        evidence: [
          ...noindex.map((page) => `noindex: ${short(page.url)}`),
          ...crossCanonical.map((page) => `canonical → ${page.canonical}`),
        ].join(" | ") || undefined,
      };
    },
  },

  /* ══════════════════════════════════════════════════════════════════
   *  PRO — Sitemap analysis
   * ════════════════════════════════════════════════════════════════ */
  {
    id: "tec-sitemap-detail",
    category: "technical",
    label: "Sitemap contents",
    weight: 4,
    failPriority: "medium",
    warnPriority: "low",
    feature: "sitemap_analysis",
    run: (s) => {
      const map = s.sitemap;
      if (!map) {
        return {
          status: "fail",
          detail:
            "We could not fetch or parse a sitemap at /sitemap.xml, /sitemap_index.xml or any address listed in robots.txt.",
          fix: "Publish an XML sitemap and reference it from robots.txt with a Sitemap: line.",
        };
      }
      if (map.isIndex && map.children.length > 0 && map.urls.length === 0) {
        return {
          status: "warn",
          detail: `The sitemap is an index pointing at ${map.children.length} child sitemap(s). We read the index but did not walk into every child.`,
          fix: "Nothing to fix if the children are valid — this is a note about the depth of our own check.",
          evidence: list(map.children.map(short), 3),
        };
      }
      if (map.urls.length === 0) {
        return {
          status: "fail",
          detail: "The sitemap parsed but lists no URLs.",
          fix: "Regenerate the sitemap — an empty one is worse than none, because it tells Google there is nothing to index.",
        };
      }
      const problems: string[] = [];
      if (map.offDomain.length > 0) {
        problems.push(`${map.offDomain.length} URL(s) point at another domain`);
      }
      if (s.sitemapUnreachable.length > 0) {
        problems.push(`${s.sitemapUnreachable.length} sampled URL(s) did not answer`);
      }
      if (problems.length > 0) {
        return {
          status: "warn",
          detail: `The sitemap lists ${map.urls.length} URL(s), but ${problems.join(" and ")}.`,
          fix: "Remove off-domain and dead entries. A sitemap full of 404s wastes the crawl budget that would otherwise reach your real pages.",
          evidence: list([...map.offDomain, ...s.sitemapUnreachable].map(short), 4),
        };
      }
      return {
        status: "pass",
        detail: `The sitemap lists ${map.urls.length} URL(s), all on your own domain, and every one we sampled answered.`,
      };
    },
  },

  /* ══════════════════════════════════════════════════════════════════
   *  PRO — Ad density
   * ════════════════════════════════════════════════════════════════ */
  {
    id: "tec-ad-density",
    category: "technical",
    label: "Ad density",
    weight: 4,
    failPriority: "high",
    warnPriority: "medium",
    feature: "ad_density_analysis",
    run: (s) => {
      const ads = s.ads;
      if (!ads) {
        return { status: "warn", detail: "Ad density was not measured for this run." };
      }
      if (ads.slots === 0 && ads.iframes === 0) {
        return {
          status: "pass",
          detail: "No existing ad slots on the pages we read, so there is nothing crowding your content.",
        };
      }
      if (ads.crowded.length > 0) {
        return {
          status: "fail",
          detail: `${ads.crowded.length} page(s) carry more ad slots than their content supports — ${ads.perThousandWords} slots per thousand words across the crawl.`,
          fix: "Cut the ad units on those pages, or lengthen the content. Ads outweighing content is an explicit policy problem, not just a taste one.",
          evidence: list(
            ads.crowded.map((page) => `${short(page.url)}: ${page.slots} slots / ${page.words} words`),
            4,
          ),
        };
      }
      if (ads.perThousandWords > 4) {
        return {
          status: "warn",
          detail: `${ads.slots} ad slot(s) across ${ads.words} words — ${ads.perThousandWords} per thousand words.`,
          fix: "Thin the placements out. Aim for content that would still be worth reading with the ads removed.",
        };
      }
      return {
        status: "pass",
        detail: `${ads.slots} ad slot(s) and ${ads.iframes} frame(s) across ${ads.words} words — ${ads.perThousandWords} per thousand, which leaves the content dominant.`,
      };
    },
  },
  {
    id: "tec-ads-txt",
    category: "technical",
    label: "ads.txt",
    weight: 2,
    failPriority: "low",
    warnPriority: "low",
    feature: "ad_density_analysis",
    run: (s) => {
      const file = s.adsTxt;
      if (!file?.found) {
        return {
          status: "warn",
          detail: "No ads.txt at the root of the domain.",
          fix: "Not required before approval, but publish one once you are approved — it is how you authorise Google to sell your inventory and prevent spoofing.",
        };
      }
      if (!file.hasGoogle) {
        return {
          status: "warn",
          detail: `ads.txt exists with ${file.lines} record(s), but none of them name google.com.`,
          fix: "Add the google.com line AdSense gives you, with your own publisher id.",
        };
      }
      return {
        status: "pass",
        detail: `ads.txt is published with ${file.lines} record(s), including a google.com entry${file.publisherIds.length > 0 ? ` for ${list(file.publisherIds, 2)}` : ""}.`,
      };
    },
  },
];

/**
 * Which checks a feature set unlocks. Ungated checks are the base read.
 *
 * This is the enforcement side of the pricing page: `basic_page_check`
 * covers the free read, and everything else has to be paid for. If you
 * add a line to a plan card, it belongs here or in the engine.
 */
export const BASE_FEATURE: FeatureKey = "basic_page_check";

/** Checks the free tier gets, mapped from the base page read. */
const FREE_CHECK_IDS = new Set([
  "cnt-depth",
  "cnt-thin",
  "cnt-h1",
  "cnt-structure",
  "cnt-lang",
  "seo-title",
  "nav-menu",
  "nav-internal",
  "nav-footer",
  "tec-status",
  "tec-speed",
]);

/** Checks bought by a feature other than the base read. */
const CHECK_FEATURE: Record<string, FeatureKey> = {
  /* Free — HTTPS check */
  "tec-https": "https_check",
  "tec-http-redirect": "https_check",

  /* Basic — advanced page check */
  "cnt-breadth": "advanced_page_check",
  "seo-description": "advanced_page_check",
  "seo-canonical": "advanced_page_check",
  "seo-noindex": "advanced_page_check",
  "seo-og": "advanced_page_check",
  "seo-alt": "advanced_page_check",
  "mob-viewport": "advanced_page_check",
  "mob-zoom": "advanced_page_check",
  "mob-fixed-width": "advanced_page_check",
  "nav-broken": "advanced_page_check",

  /* Basic — AdSense policy check */
  "pvl-privacy": "adsense_policy_check",
  "pvl-privacy-ads": "adsense_policy_check",
  "pvl-contact": "adsense_policy_check",
  "pvl-about": "adsense_policy_check",
  "pvl-terms": "adsense_policy_check",
  "pvl-cookie-notice": "adsense_policy_check",
  "cnt-restricted": "adsense_policy_check",

  /* Basic — originality and duplication */
  "cnt-placeholder": "originality_check",
  "cnt-duplicate-titles": "duplicate_content_check",

  /* Pro — robots and sitemap */
  "tec-robots": "robots_check",
  "tec-sitemap": "sitemap_analysis",
};

/** The feature a check belongs to, or the base read. */
export function featureForCheck(check: { id: string; feature?: FeatureKey }): FeatureKey {
  if (check.feature) return check.feature;
  if (FREE_CHECK_IDS.has(check.id)) return BASE_FEATURE;
  return CHECK_FEATURE[check.id] ?? BASE_FEATURE;
}

export const TOTAL_CHECKS = CHECKS.length;

/** How many checks a given feature set would run. For the pricing copy. */
export function checkCountFor(features: readonly FeatureKey[]): number {
  const active = new Set<string>(features);
  return CHECKS.filter((check) => active.has(featureForCheck(check))).length;
}

/**
 * Runs the checks this account has paid for.
 *
 * A check outside the feature set is not run and not reported — not run
 * and shown as locked, not run and shown as failing. The report simply
 * does not contain it, and `AnalysisOutcome.locked` names the features
 * that would have added more. Computing a Pro-only signal for a Free
 * account and then hiding the answer would be both a waste and a lie of
 * omission about what the tier includes.
 */
export function runChecks(
  snapshot: SiteSnapshot,
  features: readonly FeatureKey[],
): Finding[] {
  const active = new Set<string>(features);
  const findings: Finding[] = [];

  for (const check of CHECKS) {
    const feature = featureForCheck(check);
    if (!active.has(feature)) continue;

    const outcome = check.run(snapshot);
    const priority: IssuePriority =
      outcome.status === "fail"
        ? check.failPriority
        : outcome.status === "warn"
          ? check.warnPriority
          : "low";
    findings.push({
      id: check.id,
      category: check.category,
      label: check.label,
      status: outcome.status,
      detail: outcome.detail,
      fix: outcome.fix ?? "",
      priority,
      weight: check.weight,
      feature,
      ...(outcome.evidence ? { evidence: outcome.evidence } : {}),
    });
  }

  return findings;
}
