import { describeError } from "../checks";
import { toFinding, validateResult } from "../analyzers/runner";
import type { AnalyzerDef, CheckedResult } from "../analyzers/contract";
import type { Finding } from "../types";
import type { InsightContext, InsightDef } from "./contract";

/**
 * Runs the insights an account holds over a finished scan. Same rules as
 * the analyzer runner: gate first (an insight whose feature is missing is
 * never called), each call wrapped and time-limited, every result
 * validated, a failure logged and shown as "couldn't run" for that line
 * alone. Lines have weight 0 and never "fail".
 */

const DEFAULT_TIMEOUT_MS = 5_000;

const ERROR_DETAIL = "This insight couldn't be prepared because of an error on our side. It says nothing about your site.";

async function runOne(def: InsightDef, ctx: InsightContext): Promise<CheckedResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const raw = await Promise.race([
      Promise.resolve().then(() => def.run(ctx)),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out after ${def.timeoutMs ?? DEFAULT_TIMEOUT_MS} ms`)), def.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      }),
    ]);
    const checked = validateResult(raw);
    return checked.status === "fail" ? { ...checked, status: "warn" } : checked;
  } catch (error) {
    return { status: "error", findings: [], recommendation: "", features: {}, summary: ERROR_DETAIL, internalError: describeError(error) };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function runInsights(defs: readonly InsightDef[], ctx: InsightContext): Promise<{ findings: Finding[]; ran: string[] }> {
  const enabled = defs.filter((def) => ctx.features.has(def.key));
  const findings: Finding[] = [];
  // One after another: they are cheap, and several read the same tables.
  for (const def of enabled) {
    const result = await runOne(def, ctx);
    if (result.internalError) console.error(`[analysis] insight ${def.key} failed: ${result.internalError}`);
    if (result.status === "error" && !result.summary) result.summary = ERROR_DETAIL;
    const asAnalyzer: AnalyzerDef = { key: def.key, name: def.name, category: "smart", defaultPlan: "pro", scope: "site", weight: 0, run: () => ({ status: "pass", findings: [], recommendation: "" }) };
    findings.push(toFinding(asAnalyzer, result));
  }
  return { findings, ran: enabled.map((def) => def.key) };
}
