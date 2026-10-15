// Calls the site's scheduled-job endpoints — the command a scheduler runs.
//
//     APP_URL=https://your-site CRON_SECRET=... node scripts/run-scheduled-jobs.mjs [job ...]
//
// Jobs: checkout-alerts, ml, rescans (default: all three, in that order).
// It is only a client for the existing endpoints (lib/scheduler.ts); it
// starts nothing itself. Use it as a Render Cron Job's command, from any
// other scheduler, or by hand to check a deployment.
//
// Prints each job's summary. Exits 1 if any call failed (wrong secret,
// endpoint shut, server error, unreachable), so the scheduler marks the run
// as failed instead of hiding it. The secret is never printed.

const JOBS = ["checkout-alerts", "ml", "rescans"];

const base = (process.env.APP_URL || process.env.NEXT_PUBLIC_APP_URL || "").trim().replace(/\/+$/, "");
const secret = (process.env.CRON_SECRET || "").trim();
const asked = process.argv.slice(2);
const jobs = asked.length ? asked : JOBS;
const timeoutMs = Number.parseInt(process.env.JOB_TIMEOUT_MS || "", 10) || 290_000;

function fail(message) {
  console.error(`run-scheduled-jobs: ${message}`);
  process.exit(1);
}

if (!/^https?:\/\/[^/]+/.test(base)) fail("set APP_URL to the site's address, e.g. https://example.com");
if (secret.length < 32) fail("set CRON_SECRET (at least 32 characters, the same value as on the web service)");
for (const job of jobs) if (!JOBS.includes(job)) fail(`unknown job "${job}" (expected: ${JOBS.join(", ")})`);

let failed = 0;
for (const job of jobs) {
  const started = Date.now();
  let line;
  try {
    const res = await fetch(`${base}/api/internal/jobs/${job}`, {
      method: "POST",
      headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    let data = null;
    try {
      data = JSON.parse(text);
    } catch {
      /* not JSON: a proxy or platform page */
    }
    if (res.ok && data?.ok) {
      line = `ok   ${job} (${Date.now() - started} ms): ${data.summary ?? ""}`;
    } else {
      failed += 1;
      const why = data?.message ?? `HTTP ${res.status}${text ? ` — ${text.slice(0, 120).replace(/\s+/g, " ")}` : ""}`;
      line = `FAIL ${job}: ${res.status} ${why}`;
    }
  } catch (error) {
    failed += 1;
    line = `FAIL ${job}: could not reach ${base} (${error instanceof Error ? error.name : "error"})`;
  }
  console.log(line);
}
process.exit(failed ? 1 : 0);
