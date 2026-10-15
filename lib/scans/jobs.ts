import { heartbeatReports } from "@/lib/db/audits";

/**
 * Background scans, in this server process.
 *
 * A scan request is answered as soon as its report row exists; the scan
 * itself runs here. Each job:
 *
 *   - waits for a free slot (at most ANALYSIS_CONCURRENT_JOBS at once,
 *     default 3), so a burst of requests queues instead of exhausting the
 *     server;
 *   - beats every 15 s while queued or running (reports.heartbeat_at). A
 *     job whose process dies stops beating, and failStaleReports fails and
 *     refunds it 90 s later — a restart can never leave a scan "running"
 *     or keep someone's scan.
 *
 * Everything that must survive a restart is in the database; this module
 * only holds what is happening right now.
 */

const HEARTBEAT_MS = 15_000;

function maxConcurrent(): number {
  const raw = Number.parseInt(process.env.ANALYSIS_CONCURRENT_JOBS ?? "", 10);
  return Number.isInteger(raw) && raw >= 1 && raw <= 20 ? raw : 3;
}

type State = { active: number; waiting: Array<() => void>; ids: Set<string>; timer: ReturnType<typeof setInterval> | null };
const globalRef = globalThis as typeof globalThis & { __scanJobs?: State };
const state: State = (globalRef.__scanJobs ??= { active: 0, waiting: [], ids: new Set(), timer: null });

function ensureHeartbeat(): void {
  if (state.timer) return;
  state.timer = setInterval(() => {
    if (state.ids.size === 0) return;
    try {
      heartbeatReports([...state.ids]);
    } catch (error) {
      console.error("[scans] heartbeat failed", error instanceof Error ? error.message : error);
    }
  }, HEARTBEAT_MS);
  state.timer.unref?.();
}

async function acquire(): Promise<void> {
  if (state.active < maxConcurrent()) {
    state.active += 1;
    return;
  }
  await new Promise<void>((resolve) => state.waiting.push(resolve));
  state.active += 1;
}

function release(): void {
  state.active -= 1;
  const next = state.waiting.shift();
  if (next) next();
}

/**
 * Runs `work` for report `reportId` as a background job and returns its
 * promise (callers that want the result — weekly rescans — await it;
 * the API route does not). `work` must handle its own failures; anything
 * that escapes is logged, never thrown into the void.
 */
export function runScanJob<T>(reportId: string, work: () => Promise<T>): Promise<T | undefined> {
  ensureHeartbeat();
  state.ids.add(reportId);
  return (async () => {
    await acquire();
    try {
      return await work();
    } catch (error) {
      console.error(`[scans] job ${reportId} failed: ${error instanceof Error ? error.message : error}`);
      return undefined;
    } finally {
      release();
      state.ids.delete(reportId);
    }
  })();
}

/** For tests and the admin overview: what this process is doing now. */
export function scanJobStats(): { active: number; waiting: number; tracked: number } {
  return { active: state.active, waiting: state.waiting.length, tracked: state.ids.size };
}
