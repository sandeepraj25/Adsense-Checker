import type { AnalyzerDef, AnalyzerFinding } from "../contract";
import { hostOf, isOwnHost, squash } from "../util";

/**
 * "Download" buttons and links that do not lead to a download.
 *
 * A link is plausible when it points to a file (by extension), carries a
 * `download` attribute, goes to a known app store or file host, or stays
 * on this site. A download image or button sending visitors to an ad,
 * tracking or redirect address on another site is the classic fake
 * download button and fails. Links handled by scripts ("#", javascript:)
 * cannot be checked without running them, so they are only noted.
 */

const LABEL = /\bdownload\b|\bget it now\b|\binstall now\b/i;
const FILE = /\.(?:zip|rar|7z|tar|gz|tgz|bz2|exe|msi|dmg|pkg|apk|aab|ipa|deb|rpm|appimage|iso|pdf|epub|mobi|mp3|m4a|mp4|mkv|avi|mov|wav|flac|ogg|docx?|xlsx?|pptx?|odt|csv|txt|json|xml|jpe?g|png|gif|webp|svg|psd|ai|ttf|otf|woff2?)(?:$|[?#])/i;
const STORES = /(?:^|\.)(?:play\.google\.com|apps\.apple\.com|itunes\.apple\.com|microsoft\.com|chromewebstore\.google\.com|chrome\.google\.com|addons\.mozilla\.org|github\.com|githubusercontent\.com|gitlab\.com|sourceforge\.net|drive\.google\.com|docs\.google\.com|dropbox\.com|mega\.nz|mediafire\.com|wordpress\.org|npmjs\.com|pypi\.org)$/i;
const ADLIKE = /(?:^|[./-])(?:ad|ads|adserver|click|clk|track|trk|redirect|redir|go|out|offer|offers|promo|smartlink|doubleclick|popads|propeller|landing)(?:[./-]|$)/i;

export const analyzer: AnalyzerDef = {
  key: "fake_download_buttons",
  name: "Fake download buttons",
  category: "policy",
  defaultPlan: "pro",
  scope: "page",
  weight: 4,
  failPriority: "high",
  warnPriority: "medium",
  run(ctx) {
    const $ = ctx.$;
    const site = ctx.siteMeta.host;
    const findings: AnalyzerFinding[] = [];
    let fake = 0;
    let unclear = 0;
    let real = 0;

    $("a").each((_, el) => {
      const a = $(el);
      const image = a.find("img").first();
      const label = squash(`${a.text()} ${a.attr("title") ?? ""} ${a.attr("aria-label") ?? ""} ${image.attr("alt") ?? ""} ${image.attr("src") ?? ""} ${a.attr("class") ?? ""}`);
      if (!LABEL.test(label)) return;
      const href = (a.attr("href") ?? "").trim();
      if (!href || href === "#" || /^javascript:/i.test(href)) {
        unclear += 1;
        return;
      }
      const host = hostOf(href, ctx.url);
      if (a.is("[download]") || FILE.test(href) || (host && (STORES.test(host) || isOwnHost(host, site)))) {
        real += 1;
        return;
      }
      if (!host) return;
      let adlike = ADLIKE.test(host);
      try {
        adlike ||= ADLIKE.test(new URL(href, ctx.url).pathname);
      } catch {
        /* ignore */
      }
      if (image.length > 0 || adlike) {
        fake += 1;
        findings.push({ message: `A "download" ${image.length ? "image button" : "link"} goes to ${host}, not to a file.`, evidence: href.slice(0, 160), pageUrl: ctx.url });
      } else {
        unclear += 1;
      }
    });

    const features = { fake_download_buttons: fake, download_links_unclear: unclear };
    if (fake === 0) {
      return {
        status: "pass",
        findings: [],
        recommendation: "",
        confidence: unclear > 0 ? "medium" : "high",
        summary: real + unclear === 0 ? "No download buttons on this page." : `${real} download link(s) point to real files or stores${unclear ? `; ${unclear} are handled by scripts and could not be checked` : ""}.`,
        features,
      };
    }
    return {
      status: fake >= 2 || findings.some((f) => /image button/.test(f.message)) ? "fail" : "warn",
      findings,
      recommendation: "Make every download button point to the actual file or store page. Buttons styled as downloads that open ads mislead visitors and are not allowed next to AdSense.",
      features,
    };
  },
};
