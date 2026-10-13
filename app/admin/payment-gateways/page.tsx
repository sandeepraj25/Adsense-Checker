import {
  Info,
} from "lucide-react";

import {
  GatewayForm,
  type GatewayFormState,
} from "@/components/admin/GatewayForm";
import { NoRows, Panel } from "@/components/admin/Panels";
import { Badge } from "@/components/ui/Badge";
import { PageHeading } from "@/components/dashboard/PageHeading";
import { listAdminLogs } from "@/lib/db/admin";
import { APP_URL } from "@/lib/env";
import { formatDateTime } from "@/lib/format";
import { GATEWAYS, gatewayViews } from "@/lib/payments";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Payment gateways — Admin",
};

/**
 * Gateway credentials and the checkout switchboard.
 *
 * The page is assembled server-side from `gatewayViews()`, which is the
 * only reader of the credential store that is allowed to cross into a
 * component: it returns the last four characters of each secret and nothing
 * else. The plaintext never enters a props object, so it cannot end up in
 * the serialised payload the browser receives.
 */
export default async function AdminGatewaysPage() {
  const views = gatewayViews();

  const history = listAdminLogs({
    targetType: "gateway",
    limit: 20,
  });

  const gateways: GatewayFormState[] = views.map((view) => {
    const adapter = GATEWAYS[view.id];

    return {
      id: view.id,
      label: adapter.label,
      blurb: adapter.blurb,
      methods: adapter.methods,
      enabled: view.enabled,
      configured: view.configured,
      environment: view.environment,
      source: view.source,
      masked: view.masked,

      missing: adapter.fields
        .filter((field) => !view.masked[field.key])
        .map((field) => field.label),

      updatedAt: view.updatedAt,
      updatedBy: view.updatedBy,

      webhookUrl: `${APP_URL}/api/webhooks/${view.id}`,

      fields: adapter.fields.map((field) => ({
        key: field.key,
        label: field.label,
        hint: field.hint,
        secret: field.secret,
        optional: field.optional === true,
      })),
    };
  });

  const live = gateways.filter(
    (gateway) => gateway.enabled,
  );

  const sandboxEnabled = live.some(
    (gateway) => gateway.environment === "sandbox",
  );

  return (
    <div className="space-y-8">
      {/* PAGE HEADER */}
      <PageHeading
        eyebrow="Administration"
        title="Payment gateways"
        lede="Credentials are encrypted before they are stored and are never sent back to a browser. Only the last four characters of each secret appear on this page."
      />

      {/* CHECKOUT STATUS */}
      <Panel
        title="Checkout status"
        description={
          live.length === 0
            ? "No gateway is enabled, so checkout is closed until at least one gateway is configured and enabled."
            : "Customers can choose from the enabled payment gateways at checkout."
        }
        action={
          <Badge tone={live.length === 0 ? "warn" : "pass"} dot>
            {live.length === 0 ? "Checkout closed" : "Checkout open"}
          </Badge>
        }
      >
        <ul className="grid gap-2 md:grid-cols-3">
          {gateways.map((gateway) => {
            const logoSrc =
              gateway.id === "razorpay"
                ? "/razorpay.png"
                : gateway.id === "cashfree"
                  ? "/cashfree.png"
                  : gateway.id === "paypal"
                    ? "/paypal.png"
                    : "";

            return (
              <li
                key={gateway.id}
                className={`flex items-center gap-3 rounded-lg border px-3.5 py-3 ${
                  gateway.enabled ? "border-azure-500/30 bg-azure-500/[0.03]" : "border-ink-700"
                }`}
              >
                <span className="grid size-10 shrink-0 place-items-center overflow-hidden rounded-lg border border-ink-700 bg-white">
                  {logoSrc ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={logoSrc} alt="" className="size-8 object-contain" />
                  ) : null}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[0.9375rem] font-semibold text-cloud-50">{gateway.label}</span>
                  <span className="mt-1 block">
                    {gateway.enabled ? (
                      <Badge tone={gateway.environment === "live" ? "pass" : "warn"} dot>
                        {gateway.environment === "live" ? "Live" : "Sandbox"}
                      </Badge>
                    ) : (
                      <Badge tone="neutral">{gateway.configured ? "Disabled" : "Not configured"}</Badge>
                    )}
                  </span>
                </span>
              </li>
            );
          })}
        </ul>

        {sandboxEnabled ? (
          <p className="mt-4 flex items-start gap-2.5 rounded-lg border border-amber-400/20 bg-amber-400/[0.06] px-3.5 py-3 text-[0.875rem] leading-relaxed text-cloud-200">
            <Info className="mt-0.5 size-4 shrink-0 text-amber-400" aria-hidden />
            A sandbox gateway is enabled. Orders placed through it are test orders: subscriptions can
            still activate, but those payments are marked sandbox and excluded from revenue.
          </p>
        ) : null}
      </Panel>

      {/* CHECKOUT CURRENCIES */}
      <Panel
        title="Checkout currencies"
        description="What each gateway's saved settings allow. A currency reaches checkout only through an enabled gateway, and only for plans priced in it on the Pricing page."
      >
        <ul className="divide-y divide-ink-700">
          {views.map((view) => (
            <li key={view.id} className="grid gap-3 py-3.5 first:pt-0 last:pb-0 md:grid-cols-[10rem_minmax(0,1fr)]">
              <div>
                <p className="text-[0.9375rem] font-semibold text-cloud-50">{GATEWAYS[view.id].label}</p>
                <p className="mt-0.5 text-[0.8125rem] text-cloud-400">
                  {view.enabled ? "Enabled" : view.configured ? "Disabled" : "Not configured"}
                </p>
              </div>
              <dl className="grid gap-2.5 sm:grid-cols-2">
                {(["INR", "USD"] as const).map((code) => {
                  const support = view.currencies[code];
                  const usable = support.available && view.enabled;
                  return (
                    <div key={code} className="rounded-lg border border-ink-700 px-3.5 py-3">
                      <dt className="flex items-center justify-between gap-2">
                        <span className="text-[0.875rem] font-semibold text-cloud-50">{code}</span>
                        <Badge tone={usable ? "pass" : support.available ? "neutral" : "warn"}>
                          {usable ? "Available" : support.available ? "Allowed · gateway off" : "Unavailable"}
                        </Badge>
                      </dt>
                      <dd className="mt-1.5 text-[0.8125rem] leading-relaxed text-cloud-300">
                        {support.reason}
                        {support.basis === "declared" ? " (Declared by you — not checked with the provider.)" : ""}
                      </dd>
                    </div>
                  );
                })}
              </dl>
            </li>
          ))}
        </ul>
      </Panel>

      {/* PAYMENT GATEWAY FORMS */}
      {gateways.map((gateway) => (
        <GatewayForm
          key={gateway.id}
          gateway={gateway}
        />
      ))}

      {/* PAYMENT FLOW */}
      <Panel
        title="How a payment becomes a subscription"
        description="Stated because the sequence is the reason the credentials above matter."
      >
        <ol className="grid gap-3 text-[0.9375rem] leading-relaxed text-cloud-300">
          <li className="flex gap-3">
            <span className="flex size-7 shrink-0 items-center justify-center rounded-full border border-azure-500/25 text-[0.8125rem] font-semibold text-azure-600">
              1
            </span>

            <span>
              The server creates the order with the gateway, using the plan
              price read from the database — never an amount sent by the
              browser.
            </span>
          </li>

          <li className="flex gap-3">
            <span className="flex size-7 shrink-0 items-center justify-center rounded-full border border-azure-500/25 text-[0.8125rem] font-semibold text-azure-600">
              2
            </span>

            <span>
              The customer pays at the gateway, then returns to us.
            </span>
          </li>

          <li className="flex gap-3">
            <span className="flex size-7 shrink-0 items-center justify-center rounded-full border border-azure-500/25 text-[0.8125rem] font-semibold text-azure-600">
              3
            </span>

            <span>
              The server verifies what came back — Razorpay&apos;s HMAC
              signature, or a fresh capture/status call to Cashfree and
              PayPal. A browser saying &ldquo;paid&rdquo; is never sufficient.
            </span>
          </li>

          <li className="flex gap-3">
            <span className="flex size-7 shrink-0 items-center justify-center rounded-full border border-azure-500/25 text-[0.8125rem] font-semibold text-azure-600">
              4
            </span>

            <span>
              The webhook arrives independently, is verified against the
              webhook secret, and activates the subscription if step three did
              not. Duplicate deliveries of the same event are recognised and
              ignored.
            </span>
          </li>

          <li className="flex gap-3">
            <span className="flex size-7 shrink-0 items-center justify-center rounded-full border border-azure-500/25 text-[0.8125rem] font-semibold text-azure-600">
              5
            </span>

            <span>
              Only then is the subscription active, with the price, limits and
              features snapshotted at purchase.
            </span>
          </li>
        </ol>
      </Panel>

      {/* GATEWAY HISTORY */}
      <Panel
        title="Gateway change history"
        description="Which credentials changed and who changed them. The values themselves are never written to the log."
      >
        {history.length === 0 ? (
          <NoRows>
            No gateway has been changed from this panel.
          </NoRows>
        ) : (
          <ul className="divide-y divide-ink-850">
            {history.map((entry) => (
              <li
                key={entry.id}
                className="py-4 first:pt-0 last:pb-0"
              >
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <p className="flex items-center gap-2 text-base">
                    <span className="t-data font-medium text-cloud-50">
                      {entry.action}
                    </span>

                    <span className="text-cloud-400">
                      {entry.targetLabel}
                    </span>
                  </p>

                  <p className="t-data text-sm text-cloud-500">
                    {formatDateTime(entry.createdAt)}
                  </p>
                </div>

                <p className="mt-2 text-sm leading-relaxed text-cloud-300">
                  {entry.detail ?? "—"}
                </p>

                <p className="mt-1 text-sm text-cloud-500">
                  by {entry.adminEmail}
                </p>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}