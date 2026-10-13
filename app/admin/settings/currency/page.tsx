import Link from "next/link";
import { AlertTriangle, CheckCircle2, XCircle } from "lucide-react";

import { CurrencySettingForm } from "@/components/admin/CurrencySetting";
import { Panel, TableShell, Td, Th, Tr } from "@/components/admin/Panels";
import { PageHeading } from "@/components/dashboard/PageHeading";
import { requireAdmin } from "@/lib/auth/guard";
import { currencyReadiness, type CurrencyReadiness } from "@/lib/currency-readiness";
import { formatDateTime } from "@/lib/format";
import { CURRENCIES, CURRENCY_META, formatMoney } from "@/lib/money";
import { siteCurrencySetting } from "@/lib/site-currency";

export const dynamic = "force-dynamic";
export const metadata = { title: "Website currency — Admin" };

function problems(r: CurrencyReadiness): string[] {
  const out: string[] = [];
  if (r.missingPrices.length) out.push(`No ${r.currency} price for ${r.missingPrices.map((p) => p.name).join(", ")} — set it in Pricing.`);
  if (!r.payableBy.length) out.push(`No enabled payment gateway can take ${r.currency} — see Payment gateways.`);
  return out;
}

/**
 * The one currency customers see and pay in. The admin layout has
 * required an administrator; the API checks again on save.
 */
export default async function CurrencySettingsPage() {
  await requireAdmin();
  const setting = siteCurrencySetting();
  const readiness = CURRENCIES.map((code) => currencyReadiness(code));
  const active = readiness.find((r) => r.currency === setting.currency)!;
  const activeProblems = problems(active);

  return (
    <div className="space-y-6">
      <PageHeading
        eyebrow="Administration"
        title="Website currency"
        lede="One currency for every customer-facing price and checkout. Customers can't switch it."
      />

      <div
        role="status"
        className={`flex gap-3 rounded-xl border px-4 py-3.5 ${activeProblems.length ? "border-amber-400/30 bg-amber-400/[0.07]" : "border-mint-400/25 bg-mint-400/[0.06]"}`}
      >
        {activeProblems.length ? <AlertTriangle className="mt-0.5 size-5 shrink-0 text-amber-400" aria-hidden /> : <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-mint-400" aria-hidden />}
        <div className="text-[0.9375rem] leading-relaxed">
          <p className="font-semibold text-cloud-50">
            Active currency: {setting.currency} ({CURRENCY_META[setting.currency].symbol}) — {CURRENCY_META[setting.currency].name}
            {setting.saved ? "" : " · default, not saved yet"}
          </p>
          <p className="mt-0.5 text-cloud-300">
            {activeProblems.length
              ? activeProblems.join(" ")
              : `Every paid plan has a ${setting.currency} price, and ${active.payableBy.join(", ")} can take it.`}
            {setting.updatedAt ? ` Last changed ${formatDateTime(setting.updatedAt)}${setting.updatedBy ? ` by ${setting.updatedBy}` : ""}.` : ""}
          </p>
        </div>
      </div>

      <Panel title="Default Website Currency" description="Changing it takes effect immediately, with no deploy. Payments already made keep their own currency.">
        <CurrencySettingForm
          current={setting.currency}
          options={readiness.map((r) => ({
            code: r.currency,
            label: `${r.currency} (${CURRENCY_META[r.currency].symbol}) — ${CURRENCY_META[r.currency].name}`,
            ready: r.ready,
            problems: problems(r),
          }))}
        />
      </Panel>

      <Panel
        title="Plan prices by currency"
        description="Each plan has its own price in each currency. Switching currency selects the other price — it is never converted."
        action={
          <Link href="/admin/pricing" className="text-[0.875rem] font-medium text-azure-600 hover:underline">
            Edit prices
          </Link>
        }
      >
        <TableShell
          head={
            <>
              <Th>Plan</Th>
              {readiness.map((r) => (
                <Th key={r.currency}>{r.currency}</Th>
              ))}
            </>
          }
        >
          {readiness[0].prices.map((plan, i) => (
            <Tr key={plan.id}>
              <Td>{plan.name}</Td>
              {readiness.map((r) => {
                const amount = r.prices[i].amount;
                return (
                  <Td key={r.currency} mono>
                    {amount === null ? <span className="text-amber-400">Not set</span> : formatMoney(amount, r.currency)}
                  </Td>
                );
              })}
            </Tr>
          ))}
        </TableShell>
      </Panel>

      <Panel
        title="Which gateways can take each currency"
        description="From each gateway's own configuration. Nothing is converted: an order is only opened in a currency the gateway accepts. A customer's bank may still add its own conversion or foreign-transaction fees."
        action={
          <Link href="/admin/payment-gateways" className="text-[0.875rem] font-medium text-azure-600 hover:underline">
            Payment gateways
          </Link>
        }
      >
        <TableShell
          head={
            <>
              <Th>Gateway</Th>
              <Th>Status</Th>
              {readiness.map((r) => (
                <Th key={r.currency}>{r.currency}</Th>
              ))}
            </>
          }
        >
          {readiness[0].gateways.map((g, i) => (
            <Tr key={g.id}>
              <Td>{g.label}</Td>
              <Td>{g.enabled ? "Enabled" : "Off or not configured"}</Td>
              {readiness.map((r) => {
                const cell = r.gateways[i];
                return (
                  <Td key={r.currency}>
                    <span className="inline-flex items-start gap-1.5">
                      {cell.available ? <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-mint-400" aria-hidden /> : <XCircle className="mt-0.5 size-4 shrink-0 text-cloud-400" aria-hidden />}
                      <span className="text-[0.8125rem] leading-snug text-cloud-300">{cell.reason}</span>
                    </span>
                  </Td>
                );
              })}
            </Tr>
          ))}
        </TableShell>
        {readiness.map((r) => (
          <p key={r.currency} className="mt-3 text-[0.8125rem] text-cloud-400">
            Customers paying in {r.currency} can use: {r.payableBy.length ? r.payableBy.join(", ") : "no gateway right now"}.
          </p>
        ))}
      </Panel>
    </div>
  );
}
