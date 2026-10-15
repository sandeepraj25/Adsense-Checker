import type { CheerioAPI } from "cheerio";

import type { AnalyzerDef, AnalyzerFinding } from "../contract";
import { loadLinkedPage } from "../policy/privacy-page";
import { hostOf, isOwnHost, textOfSelection } from "../util";

/**
 * Whether the site can genuinely be contacted: an email address on its own
 * domain, or a contact form that submits somewhere.
 *
 * The contact page (or, without one, the homepage) is read; emails come
 * from mailto links and visible text, including "name [at] site [dot]
 * com". Free webmail addresses are allowed but weaker. A form is plausible
 * when it has a real action, posts back to the page, or uses a known form
 * plugin or service; scripted forms are reported as unverified. Nothing is
 * ever submitted.
 */

const FREE_MAIL = /^(?:gmail|googlemail|yahoo|ymail|rocketmail|outlook|hotmail|live|msn|aol|icloud|me|mac|protonmail|proton|gmx|mail|yandex|zoho|zohomail|rediffmail|tutanota|inbox|fastmail)\.(?:[a-z]{2,3})(?:\.[a-z]{2})?$/i;
const EMAIL = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
const OBFUSCATED = /([a-z0-9._%+-]+)\s*[[(]\s*at\s*[\])]\s*([a-z0-9-]+)\s*[[(]\s*dot\s*[\])]\s*([a-z]{2,})/gi;
const FORM_SERVICE = /wpcf7|wpforms|gform|ninja-forms|nf-form|elementor-form|fluentform|forminator|formspree\.io|getform\.io|basin|data-netlify|hs-form|jotform|typeform|tally\.so|docs\.google\.com\/forms|forms\.gle/i;

function emailsIn($: CheerioAPI): string[] {
  const found = new Set<string>();
  $('a[href^="mailto:"]').each((_, el) => {
    const address = ($(el).attr("href") ?? "").slice(7).split("?")[0]?.trim().toLowerCase();
    if (address && address.includes("@")) found.add(address);
  });
  const text = textOfSelection($("body"));
  for (const m of text.matchAll(EMAIL)) found.add(m[0].toLowerCase());
  for (const m of text.matchAll(OBFUSCATED)) found.add(`${m[1]}@${m[2]}.${m[3]}`.toLowerCase());
  return [...found].filter((e) => !/\.(?:png|jpe?g|gif|webp|svg)$/i.test(e) && !/example\.(?:com|org)|sentry|wixpress/i.test(e));
}

function formsIn($: CheerioAPI, html: string): { plausible: number; unverified: number } {
  let plausible = 0;
  let unverified = 0;
  $("form").each((_, el) => {
    const form = $(el);
    if (form.find("input[type=search], input[name=s]").length && form.find("textarea").length === 0) return; // a search box
    const action = (form.attr("action") ?? "").trim();
    const method = (form.attr("method") ?? "get").toLowerCase();
    const marker = FORM_SERVICE.test(`${form.attr("class") ?? ""} ${form.attr("id") ?? ""} ${action} ${Object.keys(form.attr() ?? {}).join(" ")}`);
    if (marker || (action && action !== "#" && !/^javascript:/i.test(action)) || method === "post") plausible += 1;
    else unverified += 1;
  });
  if (/<iframe[^>]+(?:docs\.google\.com\/forms|jotform|typeform|tally\.so)/i.test(html)) plausible += 1;
  return { plausible, unverified };
}

export const analyzer: AnalyzerDef = {
  key: "contact_authenticity",
  name: "Contact details",
  category: "trust",
  defaultPlan: "pro",
  scope: "site",
  weight: 3,
  failPriority: "high",
  warnPriority: "medium",
  async run(ctx) {
    const site = ctx.siteMeta.host;
    const contact = await loadLinkedPage(ctx, "contact");
    const $ = contact ? contact.$ : ctx.siteMeta.home.$();
    const where = contact ? contact.url : ctx.siteMeta.home.finalUrl;
    const emails = [...new Set([...emailsIn($), ...(contact ? emailsIn(ctx.siteMeta.home.$()) : [])])];
    const own = emails.filter((e) => isOwnHost(hostOf(`https://${e.split("@")[1]}`), site));
    const free = emails.filter((e) => FREE_MAIL.test(e.split("@")[1] ?? ""));
    const forms = formsIn($, contact?.html ?? ctx.siteMeta.home.html);
    const features = { contact_page: contact ? 1 : 0, contact_own_domain_email: own.length > 0 ? 1 : 0, contact_free_email: free.length > 0 ? 1 : 0, contact_forms: forms.plausible };

    if (own.length > 0 || forms.plausible > 0) {
      const how = [own.length ? `an email on the site's own domain (${own[0]})` : "", forms.plausible ? "a contact form that submits" : ""].filter(Boolean).join(" and ");
      return { status: "pass", findings: [], recommendation: "", summary: `Visitors can reach the site through ${how}${contact ? "" : " (found on the homepage; no contact page)"}.`, features };
    }
    const findings: AnalyzerFinding[] = [];
    if (!contact) findings.push({ message: "No contact page was found." });
    if (free.length > 0) findings.push({ message: `The only email address is free webmail (${free[0]}).`, pageUrl: where });
    if (forms.unverified > 0) findings.push({ message: "The contact form has no action we can verify; it may rely on a script.", pageUrl: where });
    if (emails.length === 0 && forms.unverified === 0) findings.push({ message: "No email address or contact form was found.", pageUrl: where });
    const other = emails.filter((e) => !free.includes(e));
    if (other.length > 0) findings.push({ message: `The contact email is on a different domain (${other[0]}).`, pageUrl: where });
    return {
      status: !contact && emails.length === 0 && forms.unverified === 0 ? "fail" : "warn",
      confidence: forms.unverified > 0 ? "low" : "medium",
      findings,
      recommendation: "Publish a contact page with a working form or an address on your own domain (for example hello@yoursite.com). It shows reviewers there is a real, reachable owner.",
      features,
    };
  },
};
