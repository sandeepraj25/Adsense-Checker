import type { AnalyzerDef, AnalyzerFinding } from "../contract";
import { hostOf, isOwnHost, squash } from "../util";

/**
 * Spam left in comment sections: links about casinos, pills, loans,
 * adult content and the like, or a pile of outbound links. Only areas
 * marked up as comments are read (WordPress and most themes use
 * #comments / .comment-list / .comment-content), including commenters'
 * own website links.
 */

const AREA = "#comments, .comments, .comment-list, .commentlist, .comments-area, .comment-content, .comment-body, [id^='comment-'], [class*='comments-']";
const SPAM = /\b(?:casino|poker|slots?|betting|bet365|jackpot|viagra|cialis|levitra|pharmacy|pills?|payday|loans?|escort|porn|xxx|adult|replica|rolex|essay writing|write my essay|seo services|buy followers|crypto (?:doubler|giveaway)|forex signals|weight loss pills)\b/i;

export const analyzer: AnalyzerDef = {
  key: "comment_spam",
  name: "Comment spam",
  category: "policy",
  defaultPlan: "pro",
  scope: "page",
  weight: 3,
  failPriority: "high",
  warnPriority: "medium",
  run(ctx) {
    const $ = ctx.$;
    const areas = $(AREA);
    if (areas.length === 0) return { status: "pass", findings: [], recommendation: "", summary: "No comment section on this page.", features: { comment_spam_links: 0 } };

    const seen = new Set<string>();
    const findings: AnalyzerFinding[] = [];
    let spam = 0;
    let outbound = 0;
    areas.find("a[href]").each((_, el) => {
      const href = $(el).attr("href") ?? "";
      if (seen.has(href) || /replytocom|#respond|#comment/.test(href)) return;
      seen.add(href);
      const host = hostOf(href, ctx.url);
      if (!host || isOwnHost(host, ctx.siteMeta.host)) return;
      outbound += 1;
      const label = squash($(el).text());
      if (SPAM.test(label) || SPAM.test(href)) {
        spam += 1;
        if (spam <= 5) findings.push({ message: `A comment links to spam (${host}).`, evidence: `${label.slice(0, 80)} → ${href.slice(0, 120)}`, pageUrl: ctx.url });
      }
    });
    if (spam === 0 && outbound >= 10) findings.push({ message: `Comments contain ${outbound} outbound links.`, pageUrl: ctx.url });

    const features = { comment_spam_links: spam, comment_outbound_links: outbound };
    if (findings.length === 0) return { status: "pass", findings: [], recommendation: "", summary: "The comment section contains no spam links.", features };
    return {
      status: spam >= 2 ? "fail" : "warn",
      findings,
      recommendation: "Delete spam comments, turn on comment moderation and an anti-spam plugin, and add rel=\"ugc nofollow\" to commenters' links.",
      features,
    };
  },
};
