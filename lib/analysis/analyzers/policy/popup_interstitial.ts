import type { AnalyzerDef, AnalyzerFinding } from "../contract";
import { textOfSelection, wordCount } from "../util";

/**
 * Pop-ups and full-screen interstitials, from the page source.
 *
 * window.open() is judged by what surrounds it: inside a click or submit
 * handler it is the visitor's own action and is fine; inside a load,
 * DOMContentLoaded or timer handler it opens a window by itself, which is
 * a fail. A visible position:fixed element covering the whole viewport is
 * a warning unless it is a cookie or consent notice. Scripts are not run,
 * so overlays a script adds later are not seen.
 */

const OVERLAY = /position\s*:\s*fixed/i;
const FULL = [
  /inset\s*:\s*0(?:px)?\s*(?:;|$)/i,
  /(?:width\s*:\s*100(?:%|vw)[^;]*;[\s\S]*height\s*:\s*100(?:%|vh)|height\s*:\s*100(?:%|vh)[^;]*;[\s\S]*width\s*:\s*100(?:%|vw))/i,
];
const CONSENT = /cookie|consent|gdpr|privacy|accept all|age (?:verification|gate)|confirm you are/i;

export function classifyWindowOpen(script: string): Array<{ kind: "automatic" | "user" | "unknown"; evidence: string }> {
  const out: Array<{ kind: "automatic" | "user" | "unknown"; evidence: string }> = [];
  for (const match of script.matchAll(/window\.open\s*\(/g)) {
    const before = script.slice(Math.max(0, match.index! - 300), match.index);
    const evidence = script.slice(match.index!, match.index! + 70);
    const lastUser = Math.max(before.lastIndexOf("click"), before.lastIndexOf("submit"), before.lastIndexOf("mousedown"), before.lastIndexOf("touchstart"));
    const lastAuto = Math.max(before.lastIndexOf("load"), before.lastIndexOf("DOMContentLoaded"), before.lastIndexOf("setTimeout"), before.lastIndexOf("setInterval"));
    out.push({ kind: lastUser > lastAuto ? "user" : lastAuto >= 0 ? "automatic" : "unknown", evidence });
  }
  return out;
}

export const analyzer: AnalyzerDef = {
  key: "popup_interstitial",
  name: "Pop-ups and interstitials",
  category: "policy",
  defaultPlan: "pro",
  scope: "page",
  weight: 3,
  failPriority: "high",
  warnPriority: "medium",
  run(ctx) {
    const $ = ctx.$;
    const findings: AnalyzerFinding[] = [];
    const scripts = $("script:not([src])").map((_, el) => $(el).text()).get().join("\n;\n").slice(0, 1_000_000);
    const bodyOnload = $("body").attr("onload") ?? "";
    const opens = [...classifyWindowOpen(scripts), ...(/window\.open/.test(bodyOnload) ? [{ kind: "automatic" as const, evidence: `<body onload="${bodyOnload.slice(0, 60)}">` }] : [])];
    const automatic = opens.filter((o) => o.kind === "automatic");
    for (const open of automatic.slice(0, 3)) findings.push({ message: "A window opens by itself when the page loads (not in response to a click).", evidence: open.evidence, pageUrl: ctx.url });

    let overlays = 0;
    $("body [style]").each((_, el) => {
      const node = $(el);
      const style = node.attr("style") ?? "";
      if (!OVERLAY.test(style) || !FULL.some((re) => re.test(style))) return;
      if (/display\s*:\s*none|visibility\s*:\s*hidden/i.test(style)) return;
      const text = textOfSelection(node);
      if (CONSENT.test(text) || wordCount(text) < 3) return;
      overlays += 1;
      if (overlays <= 3) findings.push({ message: "A full-screen overlay covers the page.", evidence: text.slice(0, 140), pageUrl: ctx.url });
    });

    const features = { auto_popups: automatic.length, fullscreen_overlays: overlays };
    if (findings.length === 0) {
      return { status: "pass", findings: [], recommendation: "", summary: opens.length ? "Windows only open in response to a visitor's click." : "No pop-ups or full-screen overlays in the page source.", features };
    }
    return {
      status: automatic.length > 0 ? "fail" : "warn",
      confidence: "medium",
      findings,
      recommendation: "Remove pop-ups that open without a click and overlays that cover the content. Google treats intrusive interstitials as a poor experience, and AdSense does not allow ads in pop-ups.",
      features,
    };
  },
};
