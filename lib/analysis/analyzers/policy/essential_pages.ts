import type { AnalyzerDef, AnalyzerFinding } from "../contract";
import { isOwnHost, hostOf } from "../util";

/**
 * About, Contact, Privacy Policy and Terms: is each one linked, and does
 * the link actually work?
 *
 * Links are discovered from every page the scan read (menus and footers
 * included), then each is checked with one status request through the
 * shared crawler — which follows redirects safely, screening every hop,
 * and reuses a page it already fetched. A page that robots.txt closes, or
 * that time ran out for, is reported as "not checked", never as broken.
 */

type Kind = "about" | "contact" | "privacy" | "terms";

const PAGES: Array<{ kind: Kind; name: string; path: RegExp; text: RegExp; required: boolean }> = [
  { kind: "privacy", name: "Privacy Policy", path: /privacy|datenschutz|privacidad/i, text: /\bprivacy\b/i, required: true },
  { kind: "contact", name: "Contact", path: /contact|kontakt|reach-?us|get-?in-?touch/i, text: /\bcontact\b|get in touch|reach us/i, required: true },
  { kind: "about", name: "About", path: /about|who-?we-?are|our-?story/i, text: /\babout\b|who we are|our story/i, required: false },
  { kind: "terms", name: "Terms", path: /terms|\btos\b|conditions|disclaimer/i, text: /\bterms\b|conditions|disclaimer/i, required: false },
];

export const analyzer: AnalyzerDef = {
  key: "essential_pages",
  name: "Essential pages",
  category: "policy",
  defaultPlan: "free",
  scope: "site",
  weight: 6,
  failPriority: "high",
  warnPriority: "medium",
  async run(ctx) {
    const site = ctx.siteMeta;
    const found = new Map<Kind, { url: string; label: string }>();

    // The engine's own discovery first (homepage links), then every page read.
    for (const page of PAGES) {
      const known = site.policyLinks[page.kind];
      if (known) found.set(page.kind, known);
    }
    for (const crawled of ctx.crawledPages) {
      for (const link of crawled.analysis.links) {
        if (!link.absolute || !isOwnHost(hostOf(link.absolute), site.host)) continue;
        let path = "";
        try {
          path = new URL(link.absolute).pathname;
        } catch {
          continue;
        }
        for (const page of PAGES) {
          if (found.has(page.kind)) continue;
          if (page.path.test(path) || page.text.test(link.text)) found.set(page.kind, { url: link.absolute, label: link.text || path });
        }
      }
    }

    const findings: AnalyzerFinding[] = [];
    let failed = 0;
    let warned = 0;
    let working = 0;

    await Promise.all(
      PAGES.map(async (page) => {
        const hit = found.get(page.kind);
        if (!hit) {
          findings.push({ message: `No ${page.name} page is linked from the pages we read.` });
          if (page.required) failed += 1;
          else warned += 1;
          return;
        }
        const status = await ctx.probe(hit.url);
        if (status === undefined) {
          findings.push({ message: `${page.name} is linked ("${hit.label.slice(0, 60)}") but was not checked (robots.txt or the time limit).`, pageUrl: hit.url });
          warned += 1;
        } else if (status === null) {
          findings.push({ message: `${page.name} is linked but did not respond.`, pageUrl: hit.url });
          failed += 1;
        } else if (!status.ok) {
          findings.push({ message: `${page.name} is linked but answers HTTP ${status.status}.`, evidence: `HTTP ${status.status}`, pageUrl: hit.url });
          failed += 1;
        } else {
          working += 1;
        }
      }),
    );

    const features = { essential_found: found.size, essential_working: working };
    if (failed === 0 && warned === 0) {
      return { status: "pass", findings: [], recommendation: "", summary: "About, Contact, Privacy Policy and Terms are all linked and load (HTTP 200).", features };
    }
    return {
      status: failed > 0 ? "fail" : "warn",
      findings,
      recommendation:
        "Publish a Privacy Policy and a Contact page (required), plus About and Terms, and link all four from your footer or menu. Fix any link that does not load.",
      features,
    };
  },
};
