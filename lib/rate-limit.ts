/**
 * Fixed-window rate limiting, in memory.
 *
 * Scope: one server process. That is enough to blunt credential
 * stuffing and repeated audit submissions from a single client on a
 * single-instance deployment. Behind several instances or on a
 * serverless platform this needs to move to Redis or Upstash — the
 * call sites would not change.
 */

type Bucket = { count: number; resetAt: number };

type GlobalWithBuckets = typeof globalThis & {
  __rateLimitBuckets?: Map<string, Bucket>;
};
const globalRef = globalThis as GlobalWithBuckets;

function store(): Map<string, Bucket> {
  if (!globalRef.__rateLimitBuckets) globalRef.__rateLimitBuckets = new Map();
  return globalRef.__rateLimitBuckets;
}

export type RateLimitResult = {
  ok: boolean;
  remaining: number;
  retryAfterSeconds: number;
};

export function rateLimit(
  key: string,
  limit: number,
  windowMs: number,
): RateLimitResult {
  const buckets = store();
  const now = Date.now();

  // Opportunistic sweep so the map cannot grow without bound.
  if (buckets.size > 5_000) {
    for (const [k, bucket] of buckets) {
      if (bucket.resetAt <= now) buckets.delete(k);
    }
  }

  const existing = buckets.get(key);
  if (!existing || existing.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return { ok: true, remaining: limit - 1, retryAfterSeconds: 0 };
  }

  existing.count += 1;
  if (existing.count > limit) {
    return {
      ok: false,
      remaining: 0,
      retryAfterSeconds: Math.max(1, Math.ceil((existing.resetAt - now) / 1000)),
    };
  }

  return {
    ok: true,
    remaining: Math.max(0, limit - existing.count),
    retryAfterSeconds: 0,
  };
}

/** Best-effort client address. Trusts the proxy headers Next surfaces. */
export function clientIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0].trim();
  return request.headers.get("x-real-ip")?.trim() || "unknown";
}
