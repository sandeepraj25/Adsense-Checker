import type { Cheerio, CheerioAPI } from "cheerio";
import type { AnyNode } from "domhandler";

import type { AnalyzerDef, AnalyzerFinding } from "../contract";
import { hostOf, isOwnHost, textOfSelection, wordCount } from "../util";

/**
 * Text and links a visitor cannot see but a crawler can: the classic
 * hidden-keyword or hidden-link trick.
 *
 * Hidden means an inline style (or a simple single-class rule in a <style>
 * block) of display:none, visibility:hidden, font-size:0, a large negative
 * text-indent or off-screen position, or text the same colour as its own
 * background. Hiding is normal for menus, dialogs, tabs, sliders, cookie
 * banners and screen-reader text, so those are excluded. Only what is
 * hidden *and* substantial counts: hidden outbound links, or a block of
 * hidden words. Nothing is rendered or executed; content that scripts
 * reveal later cannot be told apart, so findings are a review signal.
 */

const HIDDEN_STYLE = [
  { re: /display\s*:\s*none/i, how: "display:none" },
  { re: /visibility\s*:\s*hidden/i, how: "visibility:hidden" },
  { re: /font-size\s*:\s*0(?:px|em|rem|pt|%)?\s*(?:;|!|$)/i, how: "font-size:0" },
  { re: /text-indent\s*:\s*-\d{3,}/i, how: "a large negative text-indent" },
  { re: /(?:left|top)\s*:\s*-\d{4,}px/i, how: "an off-screen position" },
] as const;

const LEGIT = [
  "nav", "header nav", "menu", "dialog", "template", "noscript", "script", "style", "select", "option", "form",
  "[role=dialog]", "[role=menu]", "[role=tabpanel]", "[role=tooltip]", "[aria-modal]", "details",
  ".sr-only", ".screen-reader-text", ".visually-hidden", ".visuallyhidden", ".hidden-xs", ".hidden-sm",
  "[class*=modal]", "[class*=dropdown]", "[class*=sub-menu]", "[class*=submenu]", "[class*=menu]", "[class*=mobile]",
  "[class*=cookie]", "[class*=consent]", "[class*=gdpr]", "[class*=tooltip]", "[class*=popover]",
  "[class*=slide]", "[class*=carousel]", "[class*=tab-]", "[class*=accordion]", "[class*=collapse]", "[class*=toggle]",
  "[id*=cookie]", "[id*=consent]", "[id*=modal]", "[id*=menu]",
].join(", ");

function colour(value: string | undefined): string | null {
  return value ? value.trim().toLowerCase().replace(/\s+/g, "").replace(/!important$/, "") : null;
}

/** Single-class rules in <style> blocks that hide their element. */
function hidingClasses($: CheerioAPI): Map<string, string> {
  const classes = new Map<string, string>();
  const css = $("style").map((_, el) => $(el).text()).get().join("\n").slice(0, 200_000);
  for (const rule of css.matchAll(/(^|[}\s,])\.([a-z_][\w-]*)\s*\{([^}]*)\}/gi)) {
    const body = rule[3] ?? "";
    for (const { re, how } of HIDDEN_STYLE) if (re.test(body)) classes.set(rule[2]!, how);
  }
  return classes;
}

export const analyzer: AnalyzerDef = {
  key: "hidden_text",
  name: "Hidden text and links",
  category: "policy",
  defaultPlan: "pro",
  scope: "page",
  weight: 4,
  failPriority: "high",
  warnPriority: "medium",
  run(ctx) {
    const $ = ctx.$;
    const site = ctx.siteMeta.host;
    const classRules = hidingClasses($);
    const counted = new Set<AnyNode>();
    let hiddenWords = 0;
    let hiddenLinks = 0;
    let keywordList = false;
    const findings: AnalyzerFinding[] = [];

    const consider = (node: Cheerio<AnyNode>, how: string) => {
      const el = node.get(0);
      if (!el || counted.has(el)) return;
      if (node.is(LEGIT) || node.closest(LEGIT).length) return;
      if (node.parents().toArray().some((parent) => counted.has(parent))) return;
      const text = textOfSelection(node);
      const words = wordCount(text);
      const external = node.find("a[href]").filter((_, a) => {
        const host = hostOf($(a).attr("href") ?? "", ctx.url);
        return Boolean(host) && !isOwnHost(host, site);
      }).length + (node.is("a[href]") && !isOwnHost(hostOf(node.attr("href") ?? "", ctx.url), site) ? 1 : 0);
      if (words < 5 && external === 0) return;
      counted.add(el);
      hiddenWords += words;
      hiddenLinks += external;
      // A keyword list: many words, almost no sentence punctuation.
      const sentenceMarks = (text.match(/[.!?](?:\s|$)/g) ?? []).length;
      if (words >= 30 && sentenceMarks <= words / 40) keywordList = true;
      if (findings.length < 6) {
        findings.push({
          message: `Hidden with ${how}: ${external > 0 ? `${external} outbound link(s)` : `${words} words`}.`,
          evidence: text.slice(0, 160) || node.attr("href") || undefined,
          pageUrl: ctx.url,
        });
      }
    };

    $("body [style]").each((_, el) => {
      const node = $(el);
      const style = node.attr("style") ?? "";
      for (const { re, how } of HIDDEN_STYLE) {
        if (re.test(style)) return void consider(node, how);
      }
      const fg = colour(style.match(/(?:^|;)\s*color\s*:\s*([^;]+)/i)?.[1]);
      const bg = colour(style.match(/background(?:-color)?\s*:\s*([^;]+)/i)?.[1]);
      if (fg && bg && fg === bg) consider(node, `text the same colour as its background (${fg})`);
    });
    for (const [name, how] of classRules) {
      $(`body .${name}`).each((_, el) => consider($(el), `a .${name} rule (${how})`));
    }

    const features = { hidden_words: hiddenWords, hidden_external_links: hiddenLinks };
    const fail = hiddenLinks >= 3 || (keywordList && hiddenWords >= 40);
    const warn = hiddenLinks >= 1 || hiddenWords >= 60;
    if (!fail && !warn) {
      return { status: "pass", findings: [], recommendation: "", summary: "No substantial hidden text or hidden links.", features };
    }
    return {
      status: fail ? "fail" : "warn",
      confidence: "medium",
      findings,
      recommendation:
        "Remove text and links that are hidden from visitors. Hidden keywords or links are a webspam violation; if the content is revealed by a button or menu, make sure it is genuinely part of the page.",
      features,
    };
  },
};
