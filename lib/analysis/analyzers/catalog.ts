/**
 * The catalogue of analyzer features: what each one is called, what it
 * does, which plan gets it by default, and where it sits in the report.
 *
 * This file is deliberately data only, with no server imports, because the
 * pricing page and the admin plan editor (browser code) read it through
 * lib/plans.ts. The code that actually runs each analyzer lives beside it
 * in lib/analysis/analyzers/<category>/<key>.ts and is registered in
 * ./index.ts; the registry test checks that the two lists agree.
 *
 * Adding an entry here:
 *   - registers a new feature key, so it appears as a toggle in
 *     Admin → Plans;
 *   - seeds it ONCE onto its default plan and every plan above it, on the
 *     next start (lib/db/feature-seeds.ts). After that the administrator's
 *     choice is final — removing it from a plan is never undone by a deploy.
 *
 * `does` is shown wherever the feature is locked, so it has to describe
 * real work; every entry has an analyzer and fixture tests behind it.
 */

export type AnalyzerCategory = "content" | "policy" | "trust" | "technical" | "smart";
export type AnalyzerScope = "page" | "site";

export type AnalyzerCatalogEntry = {
  readonly key: string;
  readonly label: string;
  readonly does: string;
  readonly defaultPlan: "free" | "basic" | "pro";
  readonly category: AnalyzerCategory;
  readonly scope: AnalyzerScope;
};

export const ANALYZER_CATALOG = [
  /* ── Phase 2a: Free ───────────────────────────────────────────── */
  {
    key: "default_theme_leftovers",
    label: "Default theme leftovers",
    does: "Finds default-theme and demo content still visible — \"Hello world!\", \"Sample Page\", \"Just another WordPress site\", demo posts and comments.",
    defaultPlan: "free",
    category: "content",
    scope: "page",
  },
  {
    key: "placeholder_text",
    label: "Placeholder text",
    does: "Finds visible placeholder copy (lorem ipsum, \"coming soon\", \"under construction\", \"your text here\") and headings with no content under them.",
    defaultPlan: "free",
    category: "content",
    scope: "page",
  },
  {
    key: "essential_pages",
    label: "Essential pages",
    does: "Finds your About, Contact, Privacy Policy and Terms links on every page we read and checks each one actually loads.",
    defaultPlan: "free",
    category: "policy",
    scope: "site",
  },
  {
    key: "soft_404",
    label: "Soft 404 pages",
    does: "Requests a page that cannot exist and checks the site answers with a real 404, not a 200 \"not found\" page or the homepage.",
    defaultPlan: "free",
    category: "technical",
    scope: "site",
  },
  {
    key: "parked_domain",
    label: "Parked domain",
    does: "Detects domain-for-sale copy and markup from parking services that would show a reviewer a placeholder instead of a site.",
    defaultPlan: "free",
    category: "trust",
    scope: "site",
  },
  {
    key: "stale_copyright_year",
    label: "Stale copyright year",
    does: "Reads the copyright notice in your footer and flags a year older than last year.",
    defaultPlan: "free",
    category: "trust",
    scope: "site",
  },
  /* ── Phase 2a: Basic ──────────────────────────────────────────── */
  {
    key: "real_word_count",
    label: "Real word count",
    does: "Counts the words of real content on each page after removing navigation, header, footer, sidebars, scripts and hidden text.",
    defaultPlan: "basic",
    category: "content",
    scope: "page",
  },
  {
    key: "boilerplate_ratio",
    label: "Boilerplate ratio",
    does: "Compares text across pages to measure how much of each is repeated template (menus, sidebars, footers) versus its own content.",
    defaultPlan: "basic",
    category: "content",
    scope: "site",
  },
  {
    key: "thin_post_distribution",
    label: "Thin post distribution",
    does: "Measures what share of the articles we read have under 300 words of main content.",
    defaultPlan: "basic",
    category: "content",
    scope: "site",
  },
  {
    key: "readability_score",
    label: "Readability score",
    does: "Calculates the Flesch Reading Ease of each English page’s main content and flags very hard-to-read text.",
    defaultPlan: "basic",
    category: "content",
    scope: "page",
  },
  {
    key: "keyword_stuffing",
    label: "Keyword stuffing",
    does: "Finds two- and three-word phrases repeated unnaturally often (3% of the page’s phrases or more).",
    defaultPlan: "basic",
    category: "content",
    scope: "page",
  },
  {
    key: "clickbait_score",
    label: "Clickbait headlines",
    does: "Checks titles and headings for all-caps shouting, stacked exclamation marks, bait phrases and number bait.",
    defaultPlan: "basic",
    category: "content",
    scope: "page",
  },
  {
    key: "content_freshness",
    label: "Content freshness",
    does: "Finds the newest dated article from article metadata, <time> tags and dated URLs, and reports how old it is.",
    defaultPlan: "basic",
    category: "content",
    scope: "site",
  },
  {
    key: "hotlinked_images",
    label: "Hotlinked and stock images",
    does: "Measures how many images are served from other domains and flags stock-library file names.",
    defaultPlan: "basic",
    category: "content",
    scope: "page",
  },
  {
    key: "generic_privacy_policy",
    label: "Generic privacy policy",
    does: "Compares your privacy policy with generator-style boilerplate and catches unfilled placeholders like [Your Company Name].",
    defaultPlan: "basic",
    category: "policy",
    scope: "site",
  },
  {
    key: "privacy_ads_disclosure",
    label: "Privacy policy ad disclosures",
    does: "Checks your privacy policy mentions cookies, third-party vendors including Google, advertising and how to opt out.",
    defaultPlan: "basic",
    category: "policy",
    scope: "site",
  },
  {
    key: "ads_txt_validator",
    label: "ads.txt validation",
    does: "Validates every line of /ads.txt: ad system domain, publisher ID, DIRECT or RESELLER, and Google’s certification ID.",
    defaultPlan: "basic",
    category: "technical",
    scope: "site",
  },
  {
    key: "duplicate_adsense_tag",
    label: "Duplicate AdSense code",
    does: "Finds the AdSense script loaded more than once on a page and publisher IDs that conflict across the site.",
    defaultPlan: "basic",
    category: "policy",
    scope: "site",
  },
  /* ── Phase 2b: Pro ────────────────────────────────────────────── */
  {
    key: "cloaking_detection",
    label: "Cloaking (Googlebot vs visitors)",
    does: "Fetches your homepage and an article as Googlebot and as a normal browser, and flags pages that show the crawler different content.",
    defaultPlan: "pro",
    category: "policy",
    scope: "site",
  },
  {
    key: "hidden_text",
    label: "Hidden text and links",
    does: "Finds substantial text and outbound links hidden with CSS (display:none, zero font size, off-screen, same colour as the background).",
    defaultPlan: "pro",
    category: "policy",
    scope: "page",
  },
  {
    key: "malicious_js",
    label: "Malicious or injected JavaScript",
    does: "Scans page code for crypto-miners, eval of base64-decoded code, heavy obfuscation and invisible iframes, without running any of it.",
    defaultPlan: "pro",
    category: "policy",
    scope: "page",
  },
  {
    key: "popup_interstitial",
    label: "Pop-ups and interstitials",
    does: "Finds windows that open by themselves on page load and full-screen overlays that cover the content.",
    defaultPlan: "pro",
    category: "policy",
    scope: "page",
  },
  {
    key: "conflicting_ad_networks",
    label: "Conflicting ad networks",
    does: "Detects pop-under and push-notification ad networks from a local, versioned signature list.",
    defaultPlan: "pro",
    category: "policy",
    scope: "site",
  },
  {
    key: "auto_redirect",
    label: "Automatic redirects",
    does: "Finds meta refreshes, script redirects and address redirects that send visitors elsewhere without a click.",
    defaultPlan: "pro",
    category: "policy",
    scope: "page",
  },
  {
    key: "ad_click_encouragement",
    label: "Encouraging ad clicks",
    does: "Finds wording that asks visitors to click ads or visit sponsors, which AdSense does not allow.",
    defaultPlan: "pro",
    category: "policy",
    scope: "page",
  },
  {
    key: "fake_download_buttons",
    label: "Fake download buttons",
    does: "Finds download buttons and links that lead to ads or redirects instead of a file or store page.",
    defaultPlan: "pro",
    category: "policy",
    scope: "page",
  },
  {
    key: "ymyl_without_disclaimer",
    label: "Health and finance content without disclaimers",
    does: "Finds health and money pages that lack an author, sources or a disclaimer, and flags absolute promises.",
    defaultPlan: "pro",
    category: "policy",
    scope: "page",
  },
  {
    key: "comment_spam",
    label: "Comment spam",
    does: "Checks comment sections for casino, pharma, loan and other spam links.",
    defaultPlan: "pro",
    category: "policy",
    scope: "page",
  },
  {
    key: "affiliate_density",
    label: "Affiliate link density",
    does: "Counts affiliate links per 1,000 words and checks they are marked rel=\"sponsored\".",
    defaultPlan: "pro",
    category: "policy",
    scope: "page",
  },
  {
    key: "domain_age_whois",
    label: "Domain age (WHOIS)",
    does: "Looks up when your domain was registered, directly from the registry's WHOIS server.",
    defaultPlan: "pro",
    category: "trust",
    scope: "site",
  },
  {
    key: "tld_risk",
    label: "Top-level domain signal",
    does: "Gives a cautious signal based on how often your domain ending (.com, .xyz\u2026) is used by throwaway sites.",
    defaultPlan: "pro",
    category: "trust",
    scope: "site",
  },
  {
    key: "contact_authenticity",
    label: "Contact details",
    does: "Checks your contact page offers an email on your own domain or a working contact form.",
    defaultPlan: "pro",
    category: "trust",
    scope: "site",
  },
  {
    key: "author_bylines",
    label: "Author bylines",
    does: "Checks that articles name their author and link to an author page.",
    defaultPlan: "pro",
    category: "trust",
    scope: "site",
  },
  {
    key: "brand_consistency",
    label: "Brand consistency",
    does: "Compares your site title, logo text, og:site_name and domain to see that the site uses one name.",
    defaultPlan: "pro",
    category: "trust",
    scope: "site",
  },
  {
    key: "social_links_validity",
    label: "Social media links",
    does: "Checks social icons point to your own profiles, not to the networks' homepages.",
    defaultPlan: "pro",
    category: "trust",
    scope: "site",
  },
  {
    key: "pub_id_crosscheck",
    label: "Publisher ID cross-check",
    does: "Compares the publisher ID in your AdSense code with the IDs authorised in ads.txt.",
    defaultPlan: "pro",
    category: "policy",
    scope: "site",
  },
  {
    key: "language_check",
    label: "Page language",
    does: "Checks each page declares its language and that the declaration matches the text, using a local language detector.",
    defaultPlan: "pro",
    category: "content",
    scope: "page",
  },
  {
    key: "mixed_language_ratio",
    label: "Mixed-language content",
    does: "Estimates how much of each page mixes Hindi written in Latin letters (Hinglish) or two scripts.",
    defaultPlan: "pro",
    category: "content",
    scope: "page",
  },
  {
    key: "niche_focus",
    label: "Topic focus",
    does: "Groups your articles by topic (TF-IDF) to show whether the site sticks to one subject.",
    defaultPlan: "pro",
    category: "content",
    scope: "site",
  },
  {
    key: "publishing_velocity",
    label: "Publishing pattern",
    does: "Looks for bursts of dozens of posts on one day in article dates and the sitemap.",
    defaultPlan: "pro",
    category: "content",
    scope: "site",
  },
  {
    key: "canonical_hijack",
    label: "Canonical tags",
    does: "Finds canonical tags that point to another site, to the homepage, or conflict.",
    defaultPlan: "pro",
    category: "technical",
    scope: "page",
  },
  {
    key: "page_weight",
    label: "Page weight",
    does: "Measures the total download size of your homepage: HTML, CSS, scripts, images and fonts.",
    defaultPlan: "pro",
    category: "technical",
    scope: "site",
  },
  {
    key: "dom_complexity",
    label: "Page complexity (DOM)",
    does: "Counts the HTML elements on each page and how deeply they are nested.",
    defaultPlan: "pro",
    category: "technical",
    scope: "page",
  },
  {
    key: "images_without_dimensions",
    label: "Images without dimensions",
    does: "Lists images with no width and height, which make the page jump while loading.",
    defaultPlan: "pro",
    category: "technical",
    scope: "page",
  },
  {
    key: "third_party_scripts",
    label: "Third-party scripts",
    does: "Counts the other domains your pages load JavaScript from.",
    defaultPlan: "pro",
    category: "technical",
    scope: "site",
  },
  {
    key: "url_hygiene",
    label: "URL hygiene",
    does: "Finds internal links with session IDs, long query strings or default ?p=123 permalinks.",
    defaultPlan: "pro",
    category: "technical",
    scope: "site",
  },
  {
    key: "custom_404",
    label: "Helpful 404 page",
    does: "Checks your not-found page links back into the site instead of showing a bare server error.",
    defaultPlan: "pro",
    category: "technical",
    scope: "site",
  },
  /* ── Phase 2c: Pro smart insights ─────────────────────────────── */
  {
    key: "approval_probability",
    label: "Approval estimate",
    does: "Estimates your approval chances from this scan: a published rule-based index until enough real outcomes exist, then a model trained on outcomes other owners reported — with its version, validation figures and limits.",
    defaultPlan: "pro",
    category: "smart",
    scope: "site",
  },
  {
    key: "rejection_reason_predictor",
    label: "Likely rejection reasons",
    does: "Ranks the AdSense rejection reasons this scan points to, with how uncertain that is — never a claim about Google's own decision.",
    defaultPlan: "pro",
    category: "smart",
    scope: "site",
  },
  {
    key: "similar_sites_comparison",
    label: "Similar sites comparison",
    does: "Compares your numbers with anonymised averages of other scanned sites in the same niche, shown only when enough sites exist to keep them anonymous.",
    defaultPlan: "pro",
    category: "smart",
    scope: "site",
  },
  {
    key: "rescan_diff",
    label: "Changes since last scan",
    does: "Compares this scan with your previous scan of the same site: fixed, new and remaining problems, the score change and checks added or removed.",
    defaultPlan: "pro",
    category: "smart",
    scope: "site",
  },
  {
    key: "readiness_timeline",
    label: "Readiness timeline",
    does: "Estimates how long the remaining fixes and content gap may take at your observed publishing pace, with every assumption shown. Never a promised approval date.",
    defaultPlan: "pro",
    category: "smart",
    scope: "site",
  },
  {
    key: "scheduled_rescan",
    label: "Weekly rescans",
    does: "Rescans your site every week within your plan's allowance and emails you when findings change.",
    defaultPlan: "pro",
    category: "smart",
    scope: "site",
  },
] as const satisfies readonly AnalyzerCatalogEntry[];

export type AnalyzerKey = (typeof ANALYZER_CATALOG)[number]["key"];

export const ANALYZER_CATEGORY_LABEL: Record<AnalyzerCategory, string> = {
  content: "Content",
  policy: "Policy",
  trust: "Trust",
  technical: "Technical",
  smart: "Smart insights",
};
