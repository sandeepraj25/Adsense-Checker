import { requireAdminApi } from "@/lib/auth/guard";
import { currencyReadiness } from "@/lib/currency-readiness";
import { recordAdminAction } from "@/lib/db/admin";
import { jsonError, jsonOk, readJson } from "@/lib/http";
import { CURRENCIES, parseCurrency } from "@/lib/money";
import { setSiteCurrency, siteCurrencySetting } from "@/lib/site-currency";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The website currency and whether each currency can be sold in right now. */
export async function GET() {
  const guard = await requireAdminApi();
  if (!guard.ok) return guard.response;
  return jsonOk({
    setting: siteCurrencySetting(),
    readiness: CURRENCIES.map((code) => currencyReadiness(code)),
  });
}

/**
 * PUT { currency: "USD" | "INR", confirmed: true }
 *
 * Changes the one currency the whole customer-facing site shows and
 * charges in. Validated against the allowlist; anything else is refused.
 * Because it changes every price and checkout at once, the first request
 * without `confirmed: true` only returns what would happen (409
 * CONFIRMATION_REQUIRED with the readiness of the new currency).
 * Payments already made keep their own currency.
 */
export async function PUT(request: Request) {
  const guard = await requireAdminApi();
  if (!guard.ok) return guard.response;

  const body = await readJson(request);
  if (!body) return jsonError("VALIDATION_ERROR", "Send a JSON body.");
  const currency = parseCurrency(body.currency);
  if (!currency) {
    return jsonError("VALIDATION_ERROR", "Choose USD or INR.", { fields: { currency: "Choose USD or INR." } });
  }

  const before = siteCurrencySetting();
  const readiness = currencyReadiness(currency);
  if (body.confirmed !== true) {
    return jsonError("CONFIRMATION_REQUIRED", `Confirm switching the website to ${currency}.`, {
      extra: {
        from: before.currency,
        to: currency,
        ready: readiness.ready,
        missingPrices: readiness.missingPrices.map((plan) => plan.name).join(", "),
        payableBy: readiness.payableBy.join(", "),
      },
    });
  }

  setSiteCurrency(currency, guard.admin.email);
  recordAdminAction({
    admin: guard.admin,
    action: "settings.currency_changed",
    targetType: "system",
    targetLabel: "Website currency",
    detail: `${before.saved ? before.currency : `${before.currency} (default)`} → ${currency}${readiness.ready ? "" : " · not ready: " + [
      readiness.missingPrices.length ? `no price for ${readiness.missingPrices.map((p) => p.name).join(", ")}` : "",
      readiness.payableBy.length ? "" : "no gateway takes it",
    ].filter(Boolean).join("; ")}`,
  });
  return jsonOk({ setting: siteCurrencySetting(), readiness });
}
