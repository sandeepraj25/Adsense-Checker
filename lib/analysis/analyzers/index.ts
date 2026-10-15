import { ANALYZER_CATALOG, type AnalyzerCatalogEntry } from "./catalog";
import { analyzer as default_theme_leftovers } from "./content/default_theme_leftovers";
import { analyzer as placeholder_text } from "./content/placeholder_text";
import { analyzer as essential_pages } from "./policy/essential_pages";
import { analyzer as soft_404 } from "./technical/soft_404";
import { analyzer as parked_domain } from "./trust/parked_domain";
import { analyzer as stale_copyright_year } from "./trust/stale_copyright_year";
import { analyzer as real_word_count } from "./content/real_word_count";
import { analyzer as boilerplate_ratio } from "./content/boilerplate_ratio";
import { analyzer as thin_post_distribution } from "./content/thin_post_distribution";
import { analyzer as readability_score } from "./content/readability_score";
import { analyzer as keyword_stuffing } from "./content/keyword_stuffing";
import { analyzer as clickbait_score } from "./content/clickbait_score";
import { analyzer as content_freshness } from "./content/content_freshness";
import { analyzer as hotlinked_images } from "./content/hotlinked_images";
import { analyzer as generic_privacy_policy } from "./policy/generic_privacy_policy";
import { analyzer as privacy_ads_disclosure } from "./policy/privacy_ads_disclosure";
import { analyzer as ads_txt_validator } from "./technical/ads_txt_validator";
import { analyzer as duplicate_adsense_tag } from "./policy/duplicate_adsense_tag";
import type { AnalyzerDef } from "./contract";
import { INSIGHT_REGISTRY } from "../insights/keys";

import { analyzer as cloaking_detection } from "./policy/cloaking_detection";
import { analyzer as hidden_text } from "./policy/hidden_text";
import { analyzer as malicious_js } from "./policy/malicious_js";
import { analyzer as popup_interstitial } from "./policy/popup_interstitial";
import { analyzer as conflicting_ad_networks } from "./policy/conflicting_ad_networks";
import { analyzer as auto_redirect } from "./policy/auto_redirect";
import { analyzer as ad_click_encouragement } from "./policy/ad_click_encouragement";
import { analyzer as fake_download_buttons } from "./policy/fake_download_buttons";
import { analyzer as ymyl_without_disclaimer } from "./policy/ymyl_without_disclaimer";
import { analyzer as comment_spam } from "./policy/comment_spam";
import { analyzer as affiliate_density } from "./policy/affiliate_density";
import { analyzer as domain_age_whois } from "./trust/domain_age_whois";
import { analyzer as tld_risk } from "./trust/tld_risk";
import { analyzer as contact_authenticity } from "./trust/contact_authenticity";
import { analyzer as author_bylines } from "./trust/author_bylines";
import { analyzer as brand_consistency } from "./trust/brand_consistency";
import { analyzer as social_links_validity } from "./trust/social_links_validity";
import { analyzer as pub_id_crosscheck } from "./policy/pub_id_crosscheck";
import { analyzer as language_check } from "./content/language_check";
import { analyzer as mixed_language_ratio } from "./content/mixed_language_ratio";
import { analyzer as niche_focus } from "./content/niche_focus";
import { analyzer as publishing_velocity } from "./content/publishing_velocity";
import { analyzer as canonical_hijack } from "./technical/canonical_hijack";
import { analyzer as page_weight } from "./technical/page_weight";
import { analyzer as dom_complexity } from "./technical/dom_complexity";
import { analyzer as images_without_dimensions } from "./technical/images_without_dimensions";
import { analyzer as third_party_scripts } from "./technical/third_party_scripts";
import { analyzer as url_hygiene } from "./technical/url_hygiene";
import { analyzer as custom_404 } from "./technical/custom_404";

/**
 * Every analyzer the engine can run, one module per feature key.
 *
 * Each is listed here with its catalogue entry
 * (./catalog.ts) and fixture tests. `assertRegistry` (run by the test
 * suite) checks that every registered analyzer has a catalogue entry with
 * the same category, scope and default plan, that every catalogue entry
 * has code behind it, and that no key is used twice — so a feature cannot
 * be sold without an analyzer, or run without being sold.
 */
export const ANALYZERS: readonly AnalyzerDef[] = [
  default_theme_leftovers,
  placeholder_text,
  essential_pages,
  soft_404,
  parked_domain,
  stale_copyright_year,
  real_word_count,
  boilerplate_ratio,
  thin_post_distribution,
  readability_score,
  keyword_stuffing,
  clickbait_score,
  content_freshness,
  hotlinked_images,
  generic_privacy_policy,
  privacy_ads_disclosure,
  ads_txt_validator,
  duplicate_adsense_tag,
  cloaking_detection,
  hidden_text,
  malicious_js,
  popup_interstitial,
  conflicting_ad_networks,
  auto_redirect,
  ad_click_encouragement,
  fake_download_buttons,
  ymyl_without_disclaimer,
  comment_spam,
  affiliate_density,
  domain_age_whois,
  tld_risk,
  contact_authenticity,
  author_bylines,
  brand_consistency,
  social_links_validity,
  pub_id_crosscheck,
  language_check,
  mixed_language_ratio,
  niche_focus,
  publishing_velocity,
  canonical_hijack,
  page_weight,
  dom_complexity,
  images_without_dimensions,
  third_party_scripts,
  url_hygiene,
  custom_404,
];

export function assertRegistry(
  analyzers: readonly AnalyzerDef[] = ANALYZERS,
  catalog: readonly AnalyzerCatalogEntry[] = ANALYZER_CATALOG,
  reservedKeys: readonly string[] = [],
  /** Smart insights (../insights) run after scoring but are registered the same way. */
  insights: ReadonlyArray<Pick<AnalyzerDef, "key" | "category" | "scope" | "defaultPlan">> = INSIGHT_REGISTRY,
): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const def of [...analyzers, ...insights]) {
    if (seen.has(def.key)) problems.push(`duplicate analyzer key ${def.key}`);
    seen.add(def.key);
    if (reservedKeys.includes(def.key)) problems.push(`${def.key} collides with an existing feature or check id`);
    const entry = catalog.find((item) => item.key === def.key);
    if (!entry) {
      problems.push(`${def.key} has no catalogue entry`);
      continue;
    }
    if (entry.category !== def.category) problems.push(`${def.key}: category differs from the catalogue`);
    if (entry.scope !== def.scope) problems.push(`${def.key}: scope differs from the catalogue`);
    if (entry.defaultPlan !== def.defaultPlan) problems.push(`${def.key}: default plan differs from the catalogue`);
  }
  for (const entry of catalog) {
    if (!seen.has(entry.key)) problems.push(`catalogue entry ${entry.key} has no analyzer`);
  }
  return problems;
}
