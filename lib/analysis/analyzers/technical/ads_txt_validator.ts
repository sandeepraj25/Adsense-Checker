import type { AnalyzerDef, AnalyzerFinding } from "../contract";

/**
 * Validates /ads.txt line by line, following the IAB ads.txt format:
 *
 *   <ad system domain>, <publisher account id>, <DIRECT|RESELLER>[, <cert authority id>]
 *
 * plus comments (#), blank lines and variables (contact=, subdomain=,
 * inventorypartnerdomain=, ownerdomain=, managerdomain=). Google entries
 * are also checked for a well-formed pub-ID and Google's certification
 * ID. A missing file is a warning, not a failure: AdSense does not require
 * ads.txt to apply, but asks for it once ads are served.
 */

const VARIABLES = new Set(["contact", "subdomain", "inventorypartnerdomain", "ownerdomain", "managerdomain"]);
const DOMAIN = /^(?=.{3,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;
const GOOGLE_CERT = "f08c47fec0942fa0";

export type AdsTxtLine =
  | { kind: "record"; line: number; domain: string; account: string; relationship: "DIRECT" | "RESELLER"; cert: string | null }
  | { kind: "variable"; line: number; name: string; value: string }
  | { kind: "invalid"; line: number; text: string; problem: string };

export function parseAdsTxtLines(text: string): AdsTxtLine[] {
  const out: AdsTxtLine[] = [];
  text.split(/\r?\n/).slice(0, 20_000).forEach((raw, index) => {
    const line = index + 1;
    const content = raw.replace(/#.*$/, "").trim();
    if (!content) return;
    const variable = content.match(/^([a-z]+)\s*=\s*(.+)$/i);
    if (variable && !content.includes(",")) {
      const name = variable[1]!.toLowerCase();
      if (VARIABLES.has(name)) out.push({ kind: "variable", line, name, value: variable[2]!.trim() });
      else out.push({ kind: "invalid", line, text: content.slice(0, 120), problem: `unknown variable "${name}"` });
      return;
    }
    const fields = content.split(",").map((f) => f.trim());
    if (fields.length < 3) return void out.push({ kind: "invalid", line, text: content.slice(0, 120), problem: "fewer than three comma-separated fields" });
    const [domain = "", account = "", relationship = "", cert = ""] = fields;
    if (!DOMAIN.test(domain)) return void out.push({ kind: "invalid", line, text: content.slice(0, 120), problem: `"${domain.slice(0, 60)}" is not an ad system domain` });
    if (!account || /\s/.test(account)) return void out.push({ kind: "invalid", line, text: content.slice(0, 120), problem: "missing or malformed publisher account ID" });
    const rel = relationship.toUpperCase();
    if (rel !== "DIRECT" && rel !== "RESELLER") return void out.push({ kind: "invalid", line, text: content.slice(0, 120), problem: `relationship must be DIRECT or RESELLER, not "${relationship.slice(0, 20)}"` });
    if (domain.toLowerCase() === "google.com" && !/^pub-\d{16}$/.test(account)) {
      return void out.push({ kind: "invalid", line, text: content.slice(0, 120), problem: `"${account.slice(0, 40)}" is not a Google publisher ID (pub- followed by 16 digits)` });
    }
    out.push({ kind: "record", line, domain: domain.toLowerCase(), account, relationship: rel, cert: cert || null });
  });
  return out;
}

export const analyzer: AnalyzerDef = {
  key: "ads_txt_validator",
  name: "ads.txt validation",
  category: "technical",
  defaultPlan: "basic",
  scope: "site",
  weight: 3,
  failPriority: "high",
  warnPriority: "low",
  async run(ctx) {
    // Same request options as the engine's own ads.txt read, so it is shared.
    const result = await ctx.fetchResource(`${ctx.siteMeta.origin}/ads.txt`, { accept: "text/plain", maxBytes: 64 * 1024, timeoutMs: 8_000 });
    const html = result && (/text\/html|application\/xhtml/i.test(result.contentType) || /^\s*<(?:!doctype|html|head|body)/i.test(result.body.slice(0, 512)));
    if (!result || !result.ok || html || result.body.trim().length === 0) {
      return {
        status: "warn",
        confidence: result ? "high" : "low",
        findings: [{
          message: !result
            ? "/ads.txt could not be requested."
            : !result.ok
              ? `/ads.txt is not published (HTTP ${result.status}).`
              : html
                ? "/ads.txt returns a web page, not an ads.txt file."
                : "/ads.txt is empty.",
        }],
        recommendation: "Not required to apply, but once AdSense approves you, publish /ads.txt with the line Google gives you (google.com, pub-…, DIRECT, f08c47fec0942fa0).",
        features: { ads_txt_records: 0, ads_txt_invalid: 0, ads_txt_google: 0 },
      };
    }
    const lines = parseAdsTxtLines(result.body);
    const records = lines.filter((l) => l.kind === "record");
    const invalid = lines.filter((l) => l.kind === "invalid");
    const google = records.filter((r) => r.kind === "record" && r.domain === "google.com");
    const findings: AnalyzerFinding[] = invalid.slice(0, 10).map((l) => ({ message: `Line ${l.line}: ${l.kind === "invalid" ? l.problem : ""}.`, evidence: l.kind === "invalid" ? l.text : undefined }));
    for (const record of google) {
      if (record.kind === "record" && record.cert && record.cert.toLowerCase() !== GOOGLE_CERT) {
        findings.push({ message: `Line ${record.line}: Google's certification ID should be ${GOOGLE_CERT}.`, evidence: record.cert });
      }
    }
    if (records.length > 0 && google.length === 0) findings.push({ message: "No google.com line, so AdSense inventory is not authorised by this file." });
    const features = { ads_txt_records: records.length, ads_txt_invalid: invalid.length, ads_txt_google: google.length };

    if (records.length === 0) {
      return { status: "fail", findings: findings.length ? findings : [{ message: "The file has no valid records." }], recommendation: "Rewrite ads.txt so each line reads: ad system domain, publisher ID, DIRECT or RESELLER, and optional certification ID.", features };
    }
    if (findings.length > 0) {
      return { status: "warn", findings, recommendation: "Fix or remove the malformed lines; buyers may ignore an ads.txt with errors.", summary: `${records.length} valid record(s), ${invalid.length} malformed line(s).`, features };
    }
    return { status: "pass", findings: [], recommendation: "", summary: `ads.txt has ${records.length} valid record(s), including ${google.length} for google.com.`, features };
  },
};
