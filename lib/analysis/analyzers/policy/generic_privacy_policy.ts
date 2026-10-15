import type { AnalyzerDef } from "../contract";
import { containment, pct, shingles, words } from "../util";
import { loadPrivacyPage } from "./privacy-page";

/**
 * How closely the privacy policy matches generator-style boilerplate, and
 * whether it still contains the generator's blanks.
 *
 * The reference texts below are short, locally written examples of the
 * stock phrasing free policy generators produce. Similarity is the share
 * of the policy's six-word sequences that also appear in them. A high
 * share is a prompt to review and personalise — not proof the policy is
 * invalid or copied. Unfilled placeholders ("[Your Company Name]") are a
 * concrete problem and fail.
 */

export const TEMPLATES: string[] = [
  `At our website, accessible from our website address, one of our main priorities is the privacy of our visitors. This Privacy Policy document contains types of information that is collected and recorded by our website and how we use it. If you have additional questions or require more information about our Privacy Policy, do not hesitate to contact us. This Privacy Policy applies only to our online activities and is valid for visitors to our website with regards to the information that they shared and or collect in our website. This policy is not applicable to any information collected offline or via channels other than this website. By using our website, you hereby consent to our Privacy Policy and agree to its terms.`,
  `Like any other website, our website uses cookies. These cookies are used to store information including visitors preferences, and the pages on the website that the visitor accessed or visited. The information is used to optimize the users experience by customizing our web page content based on visitors browser type and or other information. Google is one of a third-party vendor on our site. It also uses cookies, known as DART cookies, to serve ads to our site visitors based upon their visit to our website and other sites on the internet. However, visitors may choose to decline the use of DART cookies by visiting the Google ad and content network Privacy Policy.`,
  `Our website follows a standard procedure of using log files. These files log visitors when they visit websites. All hosting companies do this and a part of hosting services analytics. The information collected by log files include internet protocol IP addresses, browser type, Internet Service Provider ISP, date and time stamp, referring exit pages, and possibly the number of clicks. These are not linked to any information that is personally identifiable. The purpose of the information is for analyzing trends, administering the site, tracking users movement on the website, and gathering demographic information.`,
  `Third-party ad servers or ad networks uses technologies like cookies, JavaScript, or Web Beacons that are used in their respective advertisements and links that appear on our website, which are sent directly to users browser. They automatically receive your IP address when this occurs. These technologies are used to measure the effectiveness of their advertising campaigns and or to personalize the advertising content that you see on websites that you visit. Note that our website has no access to or control over these cookies that are used by third-party advertisers. You can choose to disable cookies through your individual browser options.`,
  `We use the information we collect in various ways, including to provide, operate, and maintain our website, improve, personalize, and expand our website, understand and analyze how you use our website, develop new products, services, features, and functionality, communicate with you, either directly or through one of our partners, including for customer service, to provide you with updates and other information relating to the website, and for marketing and promotional purposes, send you emails, and find and prevent fraud.`,
];

const PLACEHOLDER = /\[(?:your|company|website|site|business|owner|insert|name|email|address|date)[^\]]{0,40}\]|\{\{?\s*(?:site|company|website|business)[^}]{0,30}\}\}?|\b(?:YOUR (?:WEBSITE|COMPANY|BUSINESS) NAME|COMPANY NAME HERE|WEBSITE URL HERE)\b|\b(?:www\.)?(?:yourwebsite|yoursite|example)\.com\b/i;

const REFERENCE = shingles(words(TEMPLATES.join(" \n ")), 6);

export const analyzer: AnalyzerDef = {
  key: "generic_privacy_policy",
  name: "Generic privacy policy",
  category: "policy",
  defaultPlan: "basic",
  scope: "site",
  weight: 2,
  failPriority: "high",
  warnPriority: "low",
  async run(ctx) {
    const page = await loadPrivacyPage(ctx);
    if (!page) {
      return { status: "warn", findings: [], recommendation: "", confidence: "low", summary: "No privacy policy was found to compare (see Essential pages)." };
    }
    const tokens = words(page.text);
    const blank = PLACEHOLDER.exec(page.text);
    const similarity = containment(shingles(tokens, 6), REFERENCE);
    const features = { privacy_template_similarity: Number(similarity.toFixed(3)), privacy_words: tokens.length };

    if (blank) {
      return {
        status: "fail",
        findings: [{ message: "The privacy policy still contains a generator placeholder.", evidence: blank[0], pageUrl: page.url }],
        recommendation: "Fill in every blank in the policy with your real site name, owner and contact details.",
        features,
      };
    }
    if (tokens.length < 80) {
      return { status: "pass", findings: [], recommendation: "", confidence: "low", summary: `The privacy policy is too short to compare (${tokens.length} words); see Privacy policy ad disclosures.`, features };
    }
    if (similarity >= 0.5) {
      return {
        status: "warn",
        confidence: "medium",
        findings: [{ message: `${pct(similarity)} of the policy's wording matches common generator boilerplate.`, evidence: "Six-word sequences shared with local reference texts", pageUrl: page.url }],
        recommendation: "Review the policy and make it describe what your site really does: which analytics, ads and forms you use, and how readers can reach you. A generated policy is acceptable only if it is accurate.",
        features,
      };
    }
    return { status: "pass", findings: [], recommendation: "", summary: `The privacy policy reads as written for this site (${pct(similarity)} overlap with generator boilerplate).`, features };
  },
};
