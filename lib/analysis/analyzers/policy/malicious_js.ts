import type { AnalyzerDef, AnalyzerFinding } from "../contract";
import { hostOf, isOwnHost } from "../util";

/**
 * Signs of injected or malicious JavaScript, read from the source — never
 * executed. Signature list version 2026-10.
 *
 *   fail  in-browser crypto-miners; eval() of a base64-decoded string
 *   warn  heavy obfuscation (packer, long encoded blobs, long hex escapes,
 *         document.write(unescape(…))) and invisible iframes to other sites
 *
 * Obfuscation has honest uses (some ad and analytics code ships packed),
 * so it is a warning to investigate, not a verdict. Known tag managers'
 * invisible <noscript> iframes are not counted.
 */

export const SIGNATURE_VERSION = "2026-10";

const MINERS = /coinhive|coin-hive|cryptonight|authedmine|crypto-?loot|coinimp|webminepool|webmine\.|jsecoin|minero\.cc|deepminer|cryptonoter|monerominer|cpufun|mineralt|crypto-webminer/i;
const EVAL_B64 = /eval\s*\(\s*(?:window\.)?atob\s*\(|eval\s*\(\s*decodeURIComponent\s*\(\s*escape\s*\(\s*(?:window\.)?atob/i;
const OBFUSCATION: Array<{ re: RegExp; what: string }> = [
  { re: /eval\s*\(\s*function\s*\(\s*p\s*,\s*a\s*,\s*c\s*,\s*k\s*,\s*e\s*,\s*[rd]\s*\)/i, what: "packed (p,a,c,k,e,d) code" },
  { re: /document\.write\s*\(\s*unescape\s*\(/i, what: "document.write(unescape(…))" },
  { re: /String\.fromCharCode\s*\(\s*(?:\d{2,3}\s*,\s*){80,}/, what: "a long String.fromCharCode sequence" },
  { re: /(?:\\x[0-9a-f]{2}){200,}/i, what: "a long run of hex escapes" },
  { re: /["'][A-Za-z0-9+/]{2000,}={0,2}["']/, what: "a very long base64 string" },
];
const KNOWN_INVISIBLE = /googletagmanager\.com|google\.com\/recaptcha|doubleclick\.net\/activity|facebook\.com\/tr|bat\.bing\.com/i;

export const analyzer: AnalyzerDef = {
  key: "malicious_js",
  name: "Malicious or injected JavaScript",
  category: "policy",
  defaultPlan: "pro",
  scope: "page",
  weight: 6,
  failPriority: "high",
  warnPriority: "medium",
  run(ctx) {
    const $ = ctx.$;
    const findings: AnalyzerFinding[] = [];
    let severe = 0;
    let suspicious = 0;

    const sources = $("script[src]").map((_, el) => $(el).attr("src") ?? "").get();
    const inline = $("script:not([src])").map((_, el) => $(el).text()).get().join("\n;\n").slice(0, 2_000_000);

    const miner = sources.find((src) => MINERS.test(src)) ?? (MINERS.exec(inline)?.[0] ?? null);
    if (miner) {
      severe += 1;
      findings.push({ message: "A browser crypto-miner signature is present.", evidence: miner.slice(0, 160), pageUrl: ctx.url });
    }
    const evalMatch = EVAL_B64.exec(inline);
    if (evalMatch) {
      severe += 1;
      findings.push({ message: "A script runs code decoded from base64 with eval(), a common sign of injected malware.", evidence: inline.slice(evalMatch.index, evalMatch.index + 80), pageUrl: ctx.url });
    }
    for (const { re, what } of OBFUSCATION) {
      const match = re.exec(inline);
      if (!match) continue;
      suspicious += 1;
      findings.push({ message: `Obfuscated script: ${what}.`, evidence: inline.slice(match.index, match.index + 60), pageUrl: ctx.url });
    }

    $("iframe[src]").each((_, el) => {
      const node = $(el);
      const src = node.attr("src") ?? "";
      const style = node.attr("style") ?? "";
      const tiny = ["width", "height"].some((dim) => /^\s*[01](?:px)?\s*$/.test(node.attr(dim) ?? "x"));
      const hidden = tiny || /display\s*:\s*none|visibility\s*:\s*hidden/i.test(style);
      const host = hostOf(src, ctx.url);
      if (!hidden || !host || isOwnHost(host, ctx.siteMeta.host) || KNOWN_INVISIBLE.test(src)) return;
      suspicious += 1;
      if (findings.length < 8) findings.push({ message: `An invisible iframe loads ${host}.`, evidence: src.slice(0, 160), pageUrl: ctx.url });
    });

    const features = { malicious_severe: severe, malicious_suspicious: suspicious };
    if (severe === 0 && suspicious === 0) {
      return { status: "pass", findings: [], recommendation: "", summary: `No known malicious script signatures (signature list ${SIGNATURE_VERSION}).`, features };
    }
    return {
      status: severe > 0 ? "fail" : "warn",
      confidence: severe > 0 ? "high" : "low",
      findings,
      recommendation:
        severe > 0
          ? "Treat the site as possibly compromised: remove the injected code, update your CMS, theme and plugins, change passwords, and scan the server before applying."
          : "Check where each obfuscated script or invisible iframe comes from. Remove anything you did not add yourself.",
      features,
    };
  },
};
