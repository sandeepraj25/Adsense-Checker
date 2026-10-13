import { createHmac, randomBytes } from "node:crypto";

import { one, run, tx } from "@/lib/db";
import { newId } from "@/lib/ids";
import { INTERACTION_EVENTS, validateProps, type EventName } from "./events";
import {
  classifySource,
  ipMatchesRule,
  isBot,
  isExcludedPath,
  parseUserAgent,
  type Utm,
} from "./privacy";
import { analyticsSettings, type AnalyticsSettings } from "./settings";
import { DAY_MS } from "./time";

/**
 * Writing analytics.
 *
 * Two doors: `ingestClientEvent` for the few things a browser may report
 * (page views and pricing/checkout interest), and `trackServerEvent` for
 * business events the server itself observed (accounts, payments,
 * scans). Neither ever throws into its caller — analytics must not be
 * able to break a sign-up, a checkout or a scan.
 */

export const SESSION_IDLE_MS = 30 * 60_000;

/* ── identity ───────────────────────────────────────────────────── */

function setting(key: string): string | null {
  return one<{ value: string }>("SELECT value FROM app_settings WHERE key = ?", [key])?.value ?? null;
}

/**
 * Today's salt for visitor hashes. A new random salt replaces the old one
 * at each UTC midnight and the old one is not kept, so yesterday's hashes
 * can no longer be recomputed from an address — not even by us.
 */
export function daySalt(now = Date.now()): string {
  const day = new Date(now).toISOString().slice(0, 10);
  const raw = setting("analytics.day_salt");
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as { day: string; salt: string };
      if (parsed.day === day && typeof parsed.salt === "string") return parsed.salt;
    } catch {
      /* replaced below */
    }
  }
  const fresh = JSON.stringify({ day, salt: randomBytes(32).toString("base64url") });
  if (raw === null) {
    run("INSERT OR IGNORE INTO app_settings (key, value, updated_at, updated_by) VALUES ('analytics.day_salt', ?, ?, 'system')", [fresh, now]);
  } else {
    // Only the request that sees the old value replaces it, so two
    // concurrent requests at midnight agree on one new salt.
    run("UPDATE app_settings SET value = ?, updated_at = ? WHERE key = 'analytics.day_salt' AND value = ?", [fresh, now, raw]);
  }
  const settled = JSON.parse(setting("analytics.day_salt") ?? fresh) as { salt: string };
  return settled.salt;
}

/** A long-lived key for pseudonymising ids a browser chose to share. */
function pepper(): string {
  const existing = setting("analytics.pepper");
  if (existing) return existing;
  run("INSERT OR IGNORE INTO app_settings (key, value, updated_at, updated_by) VALUES ('analytics.pepper', ?, ?, 'system')", [
    randomBytes(32).toString("base64url"),
    Date.now(),
  ]);
  return setting("analytics.pepper") as string;
}

function hmac(key: string, value: string): string {
  return createHmac("sha256", key).update(value).digest("base64url").slice(0, 24);
}

export function dayHash(ip: string, userAgent: string, now = Date.now()): string {
  return hmac(daySalt(now), `${ip}\n${userAgent}`);
}

const VISITOR_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isVisitorId(value: unknown): value is string {
  return typeof value === "string" && VISITOR_ID.test(value);
}

export function persistentVisitorKey(visitorId: string): string {
  return `p:${hmac(pepper(), `visitor:${visitorId.toLowerCase()}`)}`;
}

export function isInternalIp(ip: string, settings: AnalyticsSettings): boolean {
  return settings.internalIps.some((rule) => ipMatchesRule(ip, rule));
}

/* ── sessions ───────────────────────────────────────────────────── */

type SessionRow = { id: string; visitor_key: string; visitor_persistent: number; internal: number };

function findOpenSession(input: { dayHash: string; persistentKey: string | null; internal: number; now: number }): SessionRow | null {
  const since = input.now - SESSION_IDLE_MS;
  if (input.persistentKey) {
    const byVisitor = one<SessionRow>(
      `SELECT id, visitor_key, visitor_persistent, internal FROM analytics_sessions
        WHERE visitor_key = ? AND last_seen_at >= ? AND internal = ?
        ORDER BY last_seen_at DESC LIMIT 1`,
      [input.persistentKey, since, input.internal],
    );
    if (byVisitor) return byVisitor;
  }
  return one<SessionRow>(
    `SELECT id, visitor_key, visitor_persistent, internal FROM analytics_sessions
      WHERE day_hash = ? AND last_seen_at >= ? AND internal = ?
      ORDER BY last_seen_at DESC LIMIT 1`,
    [input.dayHash, since, input.internal],
  );
}

/* ── browser events ─────────────────────────────────────────────── */

export type ClientEventInput = {
  eventId: string;
  name: EventName;
  path: string;
  referrerHost: string | null;
  utm: Utm;
  props: Record<string, string>;
  visitorId: string | null;
  ip: string;
  userAgent: string;
  userId: string | null;
  userIsAdmin: boolean;
  country: string | null;
  /** Our own host, so internal navigation is not mistaken for a referral. */
  ownHost: string | null;
  now?: number;
};

export type IngestOutcome =
  | { status: "stored"; sessionId: string; newSession: boolean }
  | { status: "duplicate" }
  | { status: "dropped"; reason: "disabled" | "bot" | "internal" | "excluded_path" };

export function ingestClientEvent(input: ClientEventInput, settings = analyticsSettings()): IngestOutcome {
  const now = input.now ?? Date.now();
  if (!settings.enabled) return { status: "dropped", reason: "disabled" };
  if (isBot(input.userAgent)) return { status: "dropped", reason: "bot" };
  if (isExcludedPath(input.path)) return { status: "dropped", reason: "excluded_path" };

  const internal = (settings.excludeAdmins && input.userIsAdmin) || isInternalIp(input.ip, settings);
  if (internal && settings.internalMode === "drop") return { status: "dropped", reason: "internal" };

  const hash = dayHash(input.ip, input.userAgent, now);
  const persistentKey = input.visitorId && settings.consentMode === "ask" ? persistentVisitorKey(input.visitorId) : null;
  const eventKey = `c:${input.eventId.toLowerCase()}`;
  const flag = internal ? 1 : 0;

  return tx<IngestOutcome>(() => {
    if (one("SELECT 1 AS x FROM analytics_events WHERE event_key = ?", [eventKey])) return { status: "duplicate" };

    let session = findOpenSession({ dayHash: hash, persistentKey, internal: flag, now });
    let newSession = false;

    if (session) {
      // The visitor agreed to be remembered part-way through a visit.
      if (persistentKey && session.visitor_persistent === 0) {
        run("UPDATE analytics_sessions SET visitor_key = ?, visitor_persistent = 1 WHERE id = ?", [persistentKey, session.id]);
        run("UPDATE analytics_events SET visitor_key = ? WHERE session_id = ?", [persistentKey, session.id]);
        session = { ...session, visitor_key: persistentKey, visitor_persistent: 1 };
      }
    } else {
      newSession = true;
      const referrer = input.referrerHost && input.referrerHost !== input.ownHost ? input.referrerHost : null;
      const device = parseUserAgent(input.userAgent);
      const id = newId("ses");
      const visitorKey = persistentKey ?? `d:${hash}`;
      run(
        `INSERT INTO analytics_sessions
           (id, visitor_key, visitor_persistent, day_hash, user_id, started_at, last_seen_at, page_views, interactions,
            landing_path, exit_path, referrer_host, referrer_type, utm_source, utm_medium, utm_campaign, utm_term, utm_content,
            device, browser, os, country, internal)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id, visitorKey, persistentKey ? 1 : 0, hash, input.userId, now, now,
          input.path, input.path, referrer, classifySource(referrer, input.utm.utm_medium ?? null),
          input.utm.utm_source ?? null, input.utm.utm_medium ?? null, input.utm.utm_campaign ?? null,
          input.utm.utm_term ?? null, input.utm.utm_content ?? null,
          device.device, device.browser, device.os, input.country, flag,
        ],
      );
      run(
        `INSERT INTO analytics_events (id, event_key, name, source, occurred_at, session_id, visitor_key, user_id, path, props_json, internal)
         VALUES (?, ?, 'session_started', 'server', ?, ?, ?, ?, ?, '{}', ?)`,
        [newId("evt"), `s:${id}`, now, id, visitorKey, input.userId, input.path, flag],
      );
      session = { id, visitor_key: visitorKey, visitor_persistent: persistentKey ? 1 : 0, internal: flag };
    }

    const propsJson = JSON.stringify(input.props);

    // Reloading the checkout page is not a second checkout.
    if (
      input.name === "checkout_started" &&
      one("SELECT 1 AS x FROM analytics_events WHERE session_id = ? AND name = 'checkout_started' AND props_json = ?", [session.id, propsJson])
    ) {
      return { status: "duplicate" };
    }

    run(
      `INSERT INTO analytics_events (id, event_key, name, source, occurred_at, session_id, visitor_key, user_id, path, props_json, internal)
       VALUES (?, ?, ?, 'client', ?, ?, ?, ?, ?, ?, ?)`,
      [newId("evt"), eventKey, input.name, now, session.id, session.visitor_key, input.userId, input.path, propsJson, flag],
    );
    const isPage = input.name === "page_view";
    run(
      `UPDATE analytics_sessions
          SET last_seen_at = MAX(last_seen_at, ?),
              page_views   = page_views + ?,
              interactions = interactions + ?,
              exit_path    = CASE WHEN ? = 1 THEN ? ELSE exit_path END,
              user_id      = COALESCE(?, user_id)
        WHERE id = ?`,
      [now, isPage ? 1 : 0, INTERACTION_EVENTS.has(input.name) ? 1 : 0, isPage ? 1 : 0, input.path, input.userId, session.id],
    );
    return { status: "stored", sessionId: session.id, newSession };
  });
}

/* ── server events ──────────────────────────────────────────────── */

export type RequestContext = { ip: string; userAgent: string | null };

export function requestContext(request: Request, ip: string): RequestContext {
  return { ip, userAgent: request.headers.get("user-agent") };
}

/**
 * Records something the server knows happened — an account created, a
 * payment verified, a scan finished. `key` makes it idempotent: a
 * webhook redelivery or a second verify call for the same order finds
 * the row already there and adds nothing.
 *
 * The event is attached to the visitor's current visit when one can be
 * found (the same browser within the last 30 minutes, or the account's
 * own recent visit), so the funnel can follow it. It never starts a visit.
 */
export function trackServerEvent(
  name: EventName,
  options: {
    key: string;
    userId?: string | null;
    props?: Record<string, string>;
    context?: RequestContext | null;
    now?: number;
  },
): void {
  try {
    const settings = analyticsSettings();
    if (!settings.enabled) return;
    const now = options.now ?? Date.now();
    const userId = options.userId ?? null;

    let internal = false;
    if (userId && settings.excludeAdmins) {
      internal = one<{ role: string }>("SELECT role FROM users WHERE id = ?", [userId])?.role === "admin";
    }
    if (!internal && options.context && isInternalIp(options.context.ip, settings)) internal = true;
    if (internal && settings.internalMode === "drop") return;
    const flag = internal ? 1 : 0;

    let session: { id: string; visitor_key: string } | null = null;
    const since = now - SESSION_IDLE_MS;
    const ua = options.context?.userAgent ?? null;
    if (options.context && ua && !isBot(ua)) {
      session = one(
        `SELECT id, visitor_key FROM analytics_sessions
          WHERE day_hash = ? AND last_seen_at >= ? AND internal = ?
          ORDER BY last_seen_at DESC LIMIT 1`,
        [dayHash(options.context.ip, ua, now), since, flag],
      );
    }
    if (!session && userId) {
      session = one(
        `SELECT id, visitor_key FROM analytics_sessions
          WHERE user_id = ? AND last_seen_at >= ? AND internal = ?
          ORDER BY last_seen_at DESC LIMIT 1`,
        [userId, since, flag],
      );
    }

    const inserted = run(
      `INSERT OR IGNORE INTO analytics_events
         (id, event_key, name, source, occurred_at, session_id, visitor_key, user_id, path, props_json, internal)
       VALUES (?, ?, ?, 'server', ?, ?, ?, ?, NULL, ?, ?)`,
      [newId("evt"), `x:${options.key}`, name, now, session?.id ?? null, session?.visitor_key ?? null, userId, JSON.stringify(validateProps(name, options.props, { strict: false }) ?? {}), flag],
    );
    if (inserted.changes > 0 && session) {
      run(
        `UPDATE analytics_sessions
            SET interactions = interactions + ?, last_seen_at = MAX(last_seen_at, ?), user_id = COALESCE(user_id, ?)
          WHERE id = ?`,
        [INTERACTION_EVENTS.has(name) ? 1 : 0, now, userId, session.id],
      );
    }
  } catch (error) {
    console.error("[analytics]", name, error instanceof Error ? error.message : error);
  }
}

/** A stable key from a value we must not store (an email address). */
export function opaqueKey(value: string): string {
  return hmac(pepper(), `key:${value.toLowerCase()}`);
}

/* ── retention ──────────────────────────────────────────────────── */

const LAST_PURGE = "analytics.last_purge";

/** Deletes events and visits older than the retention period. */
export function purgeAnalytics(now = Date.now(), settings = analyticsSettings()): { events: number; sessions: number } {
  const cutoff = now - settings.retentionDays * DAY_MS;
  const events = run("DELETE FROM analytics_events WHERE occurred_at < ?", [cutoff]).changes;
  const sessions = run("DELETE FROM analytics_sessions WHERE last_seen_at < ?", [cutoff]).changes;
  run(
    `INSERT INTO app_settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, 'system')
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    [LAST_PURGE, JSON.stringify({ at: now, events, sessions }), now],
  );
  return { events, sessions };
}

/**
 * Runs the purge at most every six hours. The last run time lives in the
 * database, not in memory, so restarts and multiple processes agree.
 */
export function purgeAnalyticsIfDue(now = Date.now()): void {
  try {
    const raw = setting(LAST_PURGE);
    const last = raw ? (JSON.parse(raw) as { at?: number }).at ?? 0 : 0;
    if (now - last < 6 * 3_600_000) return;
    purgeAnalytics(now);
  } catch (error) {
    console.error("[analytics] purge", error instanceof Error ? error.message : error);
  }
}

export function lastPurge(): { at: number; events: number; sessions: number } | null {
  const raw = setting(LAST_PURGE);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as { at: number; events: number; sessions: number };
  } catch {
    return null;
  }
}

/* ── status ─────────────────────────────────────────────────────── */

export type TrackingStatus = {
  firstEventAt: number | null;
  lastEventAt: number | null;
  lastBrowserEventAt: number | null;
  eventsLast24h: number;
  storedEvents: number;
  storedSessions: number;
};

export function trackingStatus(now = Date.now()): TrackingStatus {
  const range = one<{ first: number | null; last: number | null; n: number }>(
    "SELECT MIN(occurred_at) AS first, MAX(occurred_at) AS last, COUNT(*) AS n FROM analytics_events",
  );
  const browser = one<{ last: number | null }>(
    "SELECT MAX(occurred_at) AS last FROM analytics_events WHERE name = 'page_view'",
  );
  const recent = one<{ n: number }>("SELECT COUNT(*) AS n FROM analytics_events WHERE occurred_at >= ?", [now - DAY_MS]);
  const sessions = one<{ n: number }>("SELECT COUNT(*) AS n FROM analytics_sessions");
  return {
    firstEventAt: range?.first ?? null,
    lastEventAt: range?.last ?? null,
    lastBrowserEventAt: browser?.last ?? null,
    eventsLast24h: recent?.n ?? 0,
    storedEvents: range?.n ?? 0,
    storedSessions: sessions?.n ?? 0,
  };
}

/** When visitor tracking began: the first recorded visit, if any. */
export function trackingStartedAt(): number | null {
  return one<{ t: number | null }>("SELECT MIN(started_at) AS t FROM analytics_sessions")?.t ?? null;
}

