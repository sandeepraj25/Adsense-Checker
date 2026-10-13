import type { FeatureKey } from "@/lib/plans";

import { type SiteSnapshot } from "./checks";
import type { PageAnalysis } from "./html";
import { composeOutcome } from "./engine";
import {
  adDensity,
  analyseStructure,
  estimateAiLikelihood,
  estimateHumanSignals,
  findDuplicates,
  originalitySignals,
  parseAdsTxt,
  type SitemapReport,
} from "./signals";
import type { AnalysisOutcome } from "./types";

/**
 * Demo reports for machines with no outbound network.
 *
 * This does not pretend to have visited anything. It assembles a
 * synthetic snapshot and runs it through the real catalogue and the real
 * composition, so the numbers are internally consistent, the plan gating
 * behaves identically and the wording is the real wording — but the
 * report is stored with analysis_mode = 'demo' and every screen that
 * renders it says so, because presenting invented findings as a real
 * audit would be a lie.
 *
 * Only reachable when ANALYSIS_DEMO_FALLBACK=true outside production.
 */

function seedFrom(text: string): number {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function mulberry32(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function page(input: {
  url: string;
  title: string;
  words: number;
  description?: string;
  extras?: Partial<PageAnalysis>;
}): PageAnalysis {
  return {
    url: input.url,
    status: 200,
    ok: true,
    title: input.title,
    metaDescription:
      input.description ??
      `${input.title} — an original, detailed write-up for readers who want the working detail rather than a summary.`,
    metaRobots: "",
    viewport: "width=device-width, initial-scale=1",
    canonical: input.url,
    lang: "en",
    ogTitle: input.title,
    ogImage: `${new URL(input.url).origin}/og.png`,
    headings1: [input.title],
    headings2: ["Background", "What to do"],
    wordCount: input.words,
    text: `${input.title} background what to do `.repeat(6),
    images: [
      { src: "/one.jpg", alt: "Illustration" },
      { src: "/two.jpg", alt: "Diagram" },
    ],
    links: [],
    hasNavElement: true,
    hasFooterElement: true,
    hasMediaQuery: true,
    hasForm: false,
    wideFixedWidths: [],
    blocksZoom: false,
    legacyPlugins: 0,
    bytes: 48_000,
    ms: 640,
    adSlots: 0,
    iframes: 0,
    paragraphCount: 8,
    depth: (() => {
      try {
        return new URL(input.url).pathname.split("/").filter(Boolean).length;
      } catch {
        return 0;
      }
    })(),
    bylineHints: ["Sample Author"],
    dateHints: ["2026-01-14"],
    ...input.extras,
  };
}

export function demoAnalysis(
  rawDomain: string,
  features: readonly FeatureKey[],
): AnalysisOutcome {
  const domain = rawDomain.toLowerCase();
  const random = mulberry32(seedFrom(domain));
  const origin = `https://${domain}`;

  // Four site personalities, so different domains produce visibly
  // different reports instead of one canned answer.
  const personality = Math.floor(random() * 4);
  const missingContact = personality !== 1;
  const missingTerms = personality === 0 || personality === 3;
  const thinPages = personality === 3 ? 2 : personality === 0 ? 1 : 0;
  const noZoom = personality === 2;
  const wideTable = personality === 3;
  const slowHome = personality === 2 || personality === 3;

  const home = page({
    url: `${origin}/`,
    title: `${domain} — field notes and long-form guides`,
    words: 820 + Math.floor(random() * 400),
    extras: {
      ms: slowHome ? 1_900 : 720,
      blocksZoom: noZoom,
      wideFixedWidths: wideTable ? [1200] : [],
    },
  });

  const pages: PageAnalysis[] = [
    home,
    page({ url: `${origin}/privacy-policy`, title: "Privacy Policy", words: 940 }),
    page({ url: `${origin}/about`, title: "About", words: 610 }),
    page({
      url: `${origin}/guides/getting-started`,
      title: "Getting started",
      words: thinPages > 0 ? 180 : 1_120,
    }),
    page({
      url: `${origin}/notes/week-12`,
      title: "Week 12 notes",
      words: thinPages > 1 ? 140 : 760,
    }),
  ];

  const privacyPage = page({
    url: `${origin}/privacy-policy`,
    title: "Privacy Policy",
    words: 940,
    extras: {
      text: "cookies advertising third-party google personalised ads opt out ".repeat(8),
    },
  });

  const internalUrls = Array.from(
    { length: 9 + Math.floor(random() * 12) },
    (_, index) => `${origin}/page-${index + 1}`,
  );

  const active = new Set<FeatureKey>(features);
  const has = (feature: FeatureKey) => active.has(feature);

  const readable = pages.filter((page) => page.ok && page.wordCount > 0);
  const corpus = (has("deep_ai_page_check") ? readable : readable.slice(0, 1))
    .map((page) => page.text)
    .join("\n\n");

  const duplicates = has("duplicate_content_check") ? findDuplicates(readable) : null;
  const demoSitemap: SitemapReport = {
    urls: internalUrls.slice(0, 8),
    children: [],
    offDomain: [],
    isIndex: false,
  };

  const snapshot: SiteSnapshot = {
    input: domain,
    origin,
    domain,
    home,
    pages,
    failedPages: [],
    policyLinks: {
      privacy: { url: `${origin}/privacy-policy`, label: "Privacy Policy" },
      about: { url: `${origin}/about`, label: "About" },
      ...(missingContact
        ? {}
        : { contact: { url: `${origin}/contact`, label: "Contact" } }),
      ...(missingTerms
        ? {}
        : { terms: { url: `${origin}/terms`, label: "Terms of Service" } }),
    },
    policyPages: { privacy: privacyPage },
    robots: has("robots_check") || has("crawlability_check") || has("sitemap_analysis")
      ? { found: true, blocksAll: false, blocksAdsBot: false, sitemaps: [`${origin}/sitemap.xml`] }
      : null,
    sitemapFound: true,
    https: true,
    httpRedirectsToHttps: personality !== 3,
    brokenLinks:
      has("advanced_page_check") && personality === 3
        ? [{ url: `${origin}/page-4`, status: 404 }]
        : [],
    sampledLinks: has("advanced_page_check") ? 8 : 0,
    hasMailto: !missingContact,
    hasContactForm: false,
    internalUrls,
    ai: has("ai_content_check") ? estimateAiLikelihood(corpus) : null,
    human: has("ai_human_content_check") ? estimateHumanSignals(readable) : null,
    originality: has("originality_check")
      ? originalitySignals(readable, duplicates?.share ?? 0)
      : null,
    duplicates,
    ads: has("ad_density_analysis") ? adDensity(readable) : null,
    adsTxt: has("ad_density_analysis")
      ? parseAdsTxt("google.com, pub-0000000000000000, DIRECT, f08c47fec0942fa0")
      : null,
    structure: has("site_structure_analysis")
      ? analyseStructure(readable, internalUrls)
      : null,
    sitemap: has("sitemap_analysis") ? demoSitemap : null,
    sitemapUnreachable: [],
  };

  // pagesFetched stays 0 and pageUrls empty: nothing was fetched, and the
  // report must not imply otherwise.
  return composeOutcome(snapshot, features, { pagesFetched: 0, pageUrls: [] });
}
