import { NextResponse } from "next/server";

import { CLIENT_EVENTS, isEventName, validateProps } from "@/lib/analytics/events";
import { referrerHost, sanitizeCountry, sanitizePath, sanitizeUtm } from "@/lib/analytics/privacy";
import { analyticsSettings } from "@/lib/analytics/settings";
import { ingestClientEvent, isVisitorId, purgeAnalyticsIfDue } from "@/lib/analytics/store";
import { getSessionUser } from "@/lib/auth/session";
import { siteCurrency } from "@/lib/site-currency";
import { jsonError, jsonServerError } from "@/lib/http";
import { clientIp, rateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";

/**
 * First-party event collection for the site's own tracker.
 *
 * Accepts only the browser events in CLIENT_EVENTS, in a strict shape:
 *
 *   { id: uuid v4, name, path, referrer?, utm?: {utm_*}, props?, vid? }
 *
 * Anything else — an unknown field, event or property, an oversized
 * body — is refused with 400. The full URL is never sent or stored: the
 * tracker sends the pathname, the server collapses ids in it, keeps only
 * the referrer's host, and reads only utm_* campaign tags.
 *
 * Bots, admin pages, signed-in administrators and listed internal
 * addresses are not recorded (see Admin → Website analytics → Settings).
 * The IP address is used for the visitor hash and the internal-address
 * check during this request and is not stored.
 */

const MAX_BODY = 4096;
const FIELDS = new Set(["id", "name", "path", "referrer", "utm", "props", "vid"]);
const EVENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function answer(body: Record<string, unknown>) {
  return NextResponse.json({ ok: true, ...body }, { status: 202, headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: Request) {
  const ip = clientIp(request);
  if (!rateLimit(`analytics:${ip}`, 240, 60_000).ok) {
    return jsonError("RATE_LIMITED", "Too many events.");
  }

  const text = await request.text().catch(() => "");
  if (text.length === 0 || text.length > MAX_BODY) return jsonError("VALIDATION_ERROR", "Invalid event.");
  let body: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("shape");
    body = parsed as Record<string, unknown>;
  } catch {
    return jsonError("VALIDATION_ERROR", "Invalid event.");
  }

  const unknownField = Object.keys(body).find((key) => !FIELDS.has(key));
  if (unknownField) return jsonError("VALIDATION_ERROR", "Invalid event.", { fields: { [unknownField.slice(0, 40)]: "Not accepted." } });

  const name = body.name;
  if (!isEventName(name) || !CLIENT_EVENTS.has(name)) return jsonError("VALIDATION_ERROR", "Unknown event.", { fields: { name: "Not accepted." } });
  if (typeof body.id !== "string" || !EVENT_ID.test(body.id)) return jsonError("VALIDATION_ERROR", "Invalid event.", { fields: { id: "Must be a random UUID." } });
  const path = sanitizePath(body.path);
  if (!path) return jsonError("VALIDATION_ERROR", "Invalid event.", { fields: { path: "Must be a page path." } });
  const props = validateProps(name, body.props, { strict: true });
  if (!props) return jsonError("VALIDATION_ERROR", "Invalid event.", { fields: { props: "Not accepted." } });
  // Prices are shown in one site-wide currency; record that, not the browser's word.
  if (name === "pricing_viewed" || name === "plan_selected" || name === "checkout_started") props.currency = siteCurrency();
  if (body.referrer !== undefined && body.referrer !== null && typeof body.referrer !== "string") {
    return jsonError("VALIDATION_ERROR", "Invalid event.", { fields: { referrer: "Not accepted." } });
  }
  if (body.utm !== undefined && (typeof body.utm !== "object" || body.utm === null || Array.isArray(body.utm))) {
    return jsonError("VALIDATION_ERROR", "Invalid event.", { fields: { utm: "Not accepted." } });
  }
  if (body.vid !== undefined && body.vid !== null && !isVisitorId(body.vid)) {
    return jsonError("VALIDATION_ERROR", "Invalid event.", { fields: { vid: "Not accepted." } });
  }

  try {
    const settings = analyticsSettings();
    if (!settings.enabled) return answer({ enabled: false });

    const session = await getSessionUser().catch(() => null);
    const countryHeader = process.env.ANALYTICS_COUNTRY_HEADER?.trim().toLowerCase();
    const host = (request.headers.get("x-forwarded-host") ?? request.headers.get("host") ?? "").split(":")[0].toLowerCase().replace(/^www\./, "");

    const outcome = ingestClientEvent(
      {
        eventId: body.id,
        name,
        path,
        referrerHost: referrerHost(body.referrer),
        utm: sanitizeUtm(body.utm),
        props,
        visitorId: typeof body.vid === "string" ? body.vid : null,
        ip,
        userAgent: request.headers.get("user-agent") ?? "",
        userId: session?.user.id ?? null,
        userIsAdmin: Boolean(session?.user.isAdmin),
        country: countryHeader ? sanitizeCountry(request.headers.get(countryHeader)) : null,
        ownHost: host || null,
      },
      settings,
    );
    if (outcome.status === "stored" && outcome.newSession) purgeAnalyticsIfDue();
    return answer({ enabled: true, status: outcome.status, consent: settings.consentMode === "ask" ? "ask" : "none" });
  } catch (error) {
    return jsonServerError("analytics/collect", error);
  }
}
