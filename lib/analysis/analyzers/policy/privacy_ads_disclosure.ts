import type { AnalyzerDef } from "../contract";
import { loadPrivacyPage } from "./privacy-page";

/**
 * Whether the privacy policy talks about the things AdSense asks
 * publishers to disclose: cookies, third-party vendors (including Google)
 * serving ads, advertising itself, and how to opt out of personalised ads.
 *
 * This is keyword matching on the policy's text. It tells you which topics
 * are mentioned and which are missing; it is not a legal review.
 */

export const TOPICS: Array<{ key: string; label: string; test: RegExp; required: boolean }> = [
  { key: "cookies", label: "cookies", test: /\bcookies?\b/i, required: true },
  { key: "third_party", label: "third-party vendors", test: /third[- ]part(?:y|ies)\b[^.]{0,120}\b(?:vendors?|advertis|ad (?:servers?|networks?)|partners?|cookies?)|(?:vendors?|ad (?:servers?|networks?))[^.]{0,80}third[- ]part/i, required: true },
  { key: "google", label: "Google as an ad vendor", test: /\bgoogle\b/i, required: true },
  { key: "advertising", label: "advertising", test: /\badvertis(?:ing|ements?|ers?)\b|\bads\b/i, required: true },
  { key: "opt_out", label: "how to opt out of personalised ads", test: /opt(?:[- ])?out|ads settings|adssettings\.google|aboutads\.info|youronlinechoices|disable cookies/i, required: true },
  { key: "personalised", label: "personalised (interest-based) ads", test: /personali[sz]ed (?:ads|advertising)|interest[- ]based|based (?:up)?on (?:your|a user['’]s) (?:prior )?visits?/i, required: false },
];

export const analyzer: AnalyzerDef = {
  key: "privacy_ads_disclosure",
  name: "Privacy policy ad disclosures",
  category: "policy",
  defaultPlan: "basic",
  scope: "site",
  weight: 5,
  failPriority: "high",
  warnPriority: "medium",
  async run(ctx) {
    const page = await loadPrivacyPage(ctx);
    if (!page) {
      return {
        status: "fail",
        findings: [{ message: "No privacy policy was found, so none of the required disclosures are made." }],
        recommendation: "Publish a privacy policy that explains cookies, third-party vendors including Google, and how readers can opt out of personalised ads.",
        features: { privacy_topics_covered: 0 },
      };
    }
    const covered = TOPICS.filter((topic) => topic.test.test(page.text));
    const missing = TOPICS.filter((topic) => topic.required && !topic.test.test(page.text));
    const features = { privacy_topics_covered: covered.length, privacy_topics_missing: missing.length };
    if (missing.length === 0) {
      return { status: "pass", findings: [], recommendation: "", summary: `The policy mentions ${covered.map((t) => t.label).join(", ")}.`, features };
    }
    const nothingOnAds = !TOPICS[0]!.test.test(page.text) && !TOPICS[3]!.test.test(page.text);
    return {
      status: nothingOnAds ? "fail" : "warn",
      findings: missing.map((topic) => ({ message: `The privacy policy doesn't mention ${topic.label}.`, pageUrl: page.url })),
      recommendation: "Add a section on advertising: that third-party vendors including Google use cookies to serve ads based on prior visits, and how readers can opt out (Google Ads Settings or aboutads.info). This is keyword matching, not legal advice.",
      summary: `Mentioned: ${covered.map((t) => t.label).join(", ") || "none of the topics"}. Missing: ${missing.map((t) => t.label).join(", ")}.`,
      features,
    };
  },
};
