
"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import {
  Download,
  Eye,
  FileDown,
  Filter,
  Search,
} from "lucide-react";

import { Badge } from "@/components/ui/Badge";
import type {
  listInvoices,
  listPayments,
  listSubscriptions,
} from "@/lib/db/billing";
import { formatDate, formatDateTime } from "@/lib/format";
import { formatMoney } from "@/lib/money";
// Not "@/lib/payments": that module is server-only (node:crypto, the database).
import { gatewayDisplayName as gatewayLabel } from "@/lib/payments/labels";

type Payments = ReturnType<typeof listPayments>;
type Invoices = ReturnType<typeof listInvoices>;
type Subscriptions = ReturnType<typeof listSubscriptions>;

type Props = {
  payments: Payments;
  invoices: Invoices;
  subscriptions: Subscriptions;
  /** Plan id → display name, from the plan catalogue. */
  planNames: Record<string, string>;
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Oct 2026" in IST, matching lib/format's timezone so server and client agree. */
function monthLabel(ms: number): string {
  const d = new Date(ms + 5.5 * 3_600_000);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

const STATUS: Record<string, { label: string; dot: string; text: string }> = {
  paid: { label: "Success", dot: "bg-emerald-500", text: "text-emerald-600" },
  created: { label: "Processing", dot: "bg-orange-500", text: "text-orange-600" },
  pending: { label: "Processing", dot: "bg-orange-500", text: "text-orange-600" },
  processing: { label: "Processing", dot: "bg-orange-500", text: "text-orange-600" },
  failed: { label: "Failed", dot: "bg-rose-500", text: "text-rose-600" },
  cancelled: { label: "Cancelled", dot: "bg-zinc-400", text: "text-cloud-400" },
  canceled: { label: "Cancelled", dot: "bg-zinc-400", text: "text-cloud-400" },
};

function StatusLabel({ status }: { status: string }) {
  const meta = STATUS[status] ?? { label: status, dot: "bg-zinc-400", text: "text-cloud-400" };
  return (
    <span className={`inline-flex items-center gap-1.5 text-[0.8125rem] font-medium ${meta.text}`}>
      <span aria-hidden className={`size-1.5 rounded-full ${meta.dot}`} />
      {meta.label}
    </span>
  );
}

type StatusFilter =
  | "all"
  | "paid"
  | "pending"
  | "failed";

function csvEscape(value: string | number) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

export function BillingHistoryTable({
  payments,
  invoices,
  subscriptions,
  planNames,
}: Props) {
  const [query, setQuery] = useState("");
  const [status, setStatus] =
    useState<StatusFilter>("all");
  const [showFilters, setShowFilters] =
    useState(false);

  const invoiceByPayment = useMemo(
    () =>
      new Map(
        invoices.map((invoice) => [
          invoice.paymentId,
          invoice,
        ]),
      ),
    [invoices],
  );

  const subscriptionById = useMemo(
    () => new Map(subscriptions.map((subscription) => [subscription.id, subscription])),
    [subscriptions],
  );

  const planName = (payment: Payments[number]) =>
    (payment.subscriptionId ? subscriptionById.get(payment.subscriptionId)?.planName : undefined) ??
    planNames[payment.planId] ??
    payment.planId;

  const endDate = (payment: Payments[number]) =>
    payment.subscriptionId ? subscriptionById.get(payment.subscriptionId)?.expiresAt ?? null : null;

  const filtered = useMemo(() => {
    const search = query.trim().toLowerCase();

    return payments.filter((payment) => {
      const invoice = invoiceByPayment.get(payment.id);

      const matchesSearch =
        !search ||
        [
          planName(payment),
          payment.orderId,
          payment.paymentId ?? "",
          payment.method ?? "",
          gatewayLabel(payment.gateway),
          invoice?.number ?? "",
          payment.status,
          String(payment.amountPaise / 100),
        ]
          .join(" ")
          .toLowerCase()
          .includes(search);

      const normalized = String(payment.status).toLowerCase();

      const matchesStatus =
        status === "all" ||
        (status === "paid" && normalized === "paid") ||
        (status === "pending" &&
          ["pending", "created", "processing"].includes(
            normalized,
          )) ||
        (status === "failed" &&
          ["failed", "cancelled", "canceled"].includes(
            normalized,
          ));

      return matchesSearch && matchesStatus;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [payments, query, status, invoiceByPayment, subscriptionById, planNames]);

  function exportCsv() {
    const header = [
      "Plan",
      "Order ID",
      "Payment ID",
      "Gateway",
      "Amount",
      "Currency",
      "Status",
      "Purchase date",
      "End date",
      "Invoice",
    ];

    const rows = filtered.map((payment) => {
      const invoice = invoiceByPayment.get(payment.id);

      return [
        planName(payment),
        payment.orderId,
        payment.paymentId ?? "",
        gatewayLabel(payment.gateway),
        (payment.amountPaise / 100).toFixed(2),
        payment.currency,
        payment.status,
        formatDateTime(payment.createdAt),
        endDate(payment) ? formatDate(endDate(payment) as number) : "",
        invoice?.number ?? "",
      ];
    });

    const csv = [header, ...rows]
      .map((row) => row.map(csvEscape).join(","))
      .join("\r\n");

    const blob = new Blob(["\uFEFF", csv], {
      type: "text/csv;charset=utf-8;",
    });

    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");

    anchor.href = url;
    anchor.download = "billing-history.csv";
    anchor.click();

    URL.revokeObjectURL(url);
  }

  const iconButton =
    "grid size-8 place-items-center rounded-lg border border-ink-700 bg-white text-cloud-300 transition-colors hover:border-zinc-300 hover:text-cloud-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-azure-500";
  const toolButton =
    "inline-flex h-9 items-center justify-center gap-1.5 rounded-lg border border-ink-700 bg-white px-3 text-[0.8125rem] font-medium text-cloud-100 transition-colors hover:border-zinc-300 hover:text-cloud-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-azure-500";

  return (
    <div className="overflow-hidden rounded-2xl border border-ink-700 bg-white shadow-[0_1px_2px_rgba(24,24,27,0.04)]">
      {/* Title, search and actions */}
      <div className="flex flex-col gap-3 px-4 pb-3 pt-4 sm:flex-row sm:items-center sm:justify-between sm:px-5 sm:pt-5">
        <h2 className="text-[1rem] font-semibold text-cloud-50">Billing History</h2>

        <div className="flex flex-wrap items-center gap-2">
          <label className="relative min-w-0 flex-1 sm:w-48 sm:flex-none">
            <Search aria-hidden className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-cloud-400" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search..."
              aria-label="Search billing history"
              className="h-9 w-full rounded-lg border border-ink-700 bg-white pl-8 pr-3 text-[0.8125rem] text-cloud-50 outline-none placeholder:text-cloud-400 focus:border-azure-500"
            />
          </label>

          <button
            type="button"
            onClick={() => setShowFilters((value) => !value)}
            aria-expanded={showFilters}
            aria-controls="billing-filters"
            className={toolButton}
          >
            <Filter aria-hidden className="size-4" />
            Filter
          </button>

          <button type="button" onClick={exportCsv} className={toolButton}>
            <Download aria-hidden className="size-4" />
            Export
          </button>
        </div>
      </div>

      {showFilters ? (
        <div id="billing-filters" className="flex flex-wrap items-center gap-3 border-t border-ink-700 px-4 py-3 sm:px-5">
          <label htmlFor="billing-status-filter" className="text-[0.8125rem] text-cloud-400">
            Payment status
          </label>
          <select
            id="billing-status-filter"
            value={status}
            onChange={(event) => setStatus(event.target.value as StatusFilter)}
            className="h-9 rounded-lg border border-ink-700 bg-white px-3 text-[0.8125rem] text-cloud-50 outline-none focus:border-azure-500"
          >
            <option value="all">All statuses</option>
            <option value="paid">Successful</option>
            <option value="pending">Pending / Processing</option>
            <option value="failed">Failed / Cancelled</option>
          </select>
          <button
            type="button"
            onClick={() => {
              setStatus("all");
              setQuery("");
            }}
            className="text-[0.8125rem] font-medium text-azure-600 hover:underline"
          >
            Clear filters
          </button>
        </div>
      ) : null}

      {/* Desktop table */}
      <div className="hidden px-3 pb-3 md:block">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[760px] text-left">
            <thead>
              <tr className="bg-ink-900">
                {["Plan Name", "Amounts", "Purchase Date", "End Date", "Status", "Action"].map((heading, i) => (
                  <th
                    key={heading}
                    scope="col"
                    className={`px-3 py-2.5 text-[0.8125rem] font-medium text-cloud-400 ${i === 0 ? "rounded-l-lg" : ""} ${i === 5 ? "rounded-r-lg" : ""}`}
                  >
                    {heading}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-850">
              {filtered.map((payment) => {
                const invoice = invoiceByPayment.get(payment.id);
                const end = endDate(payment);
                return (
                  <tr key={payment.id} className="transition-colors hover:bg-ink-900/60">
                    <td className="px-3 py-3.5">
                      <p className="text-[0.875rem] font-medium text-cloud-50">
                        {planName(payment)} Plan - {monthLabel(payment.createdAt)}
                      </p>
                      <p className="mt-0.5 text-[0.75rem] text-cloud-400">
                        {gatewayLabel(payment.gateway)}
                        {payment.method ? ` · ${payment.method}` : ""}
                      </p>
                      <p className="t-data mt-0.5 max-w-[260px] truncate text-[0.6875rem] text-cloud-400" title={`Order ${payment.orderId}${payment.paymentId ? ` · Payment ${payment.paymentId}` : ""}`}>
                        Order {payment.orderId}
                        {payment.paymentId ? ` · ${payment.paymentId}` : ""}
                      </p>
                    </td>
                    <td className="t-data whitespace-nowrap px-3 py-3.5 text-[0.875rem] font-medium text-cloud-50">
                      {formatMoney(payment.amountPaise, payment.currency)}
                    </td>
                    <td className="t-data whitespace-nowrap px-3 py-3.5 text-[0.875rem] text-cloud-100">{formatDate(payment.createdAt)}</td>
                    <td className="t-data whitespace-nowrap px-3 py-3.5 text-[0.875rem] text-cloud-100">{end ? formatDate(end) : "—"}</td>
                    <td className="px-3 py-3.5">
                      <StatusLabel status={String(payment.status).toLowerCase()} />
                      {payment.mode === "mock" ? (
                        <div className="mt-1.5">
                          <Badge tone="brand">Test payment</Badge>
                        </div>
                      ) : payment.environment === "sandbox" ? (
                        <div className="mt-1.5">
                          <Badge tone="warn">Sandbox</Badge>
                        </div>
                      ) : null}
                      {payment.failureReason ? <p className="mt-1 max-w-[180px] text-[0.75rem] text-cloud-400">{payment.failureReason}</p> : null}
                    </td>
                    <td className="px-3 py-3.5">
                      {invoice ? (
                        <div className="flex items-center gap-2">
                          <Link href={`/dashboard/billing/invoices/${invoice.id}`} title="Download invoice" aria-label={`Download invoice ${invoice.number}`} className={iconButton}>
                            <FileDown aria-hidden className="size-4" />
                          </Link>
                          <Link href={`/dashboard/billing/invoices/${invoice.id}`} title="View invoice" aria-label={`View invoice ${invoice.number}`} className={iconButton}>
                            <Eye aria-hidden className="size-4" />
                          </Link>
                        </div>
                      ) : (
                        <span className="text-[0.75rem] text-cloud-400">No invoice</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Mobile cards */}
      <div className="divide-y divide-ink-850 border-t border-ink-700 md:hidden">
        {filtered.map((payment) => {
          const invoice = invoiceByPayment.get(payment.id);
          const end = endDate(payment);
          return (
            <article key={payment.id} className="space-y-2.5 p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-[0.875rem] font-medium text-cloud-50">
                    {planName(payment)} Plan - {monthLabel(payment.createdAt)}
                  </p>
                  <p className="mt-0.5 text-[0.75rem] text-cloud-400">
                    {formatDate(payment.createdAt)}
                    {end ? ` → ${formatDate(end)}` : ""} · {gatewayLabel(payment.gateway)}
                  </p>
                </div>
                <p className="t-data shrink-0 text-[0.875rem] font-semibold text-cloud-50">{formatMoney(payment.amountPaise, payment.currency)}</p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <StatusLabel status={String(payment.status).toLowerCase()} />
                {payment.mode === "mock" ? <Badge tone="brand">Test payment</Badge> : payment.environment === "sandbox" ? <Badge tone="warn">Sandbox</Badge> : null}
              </div>
              <p className="t-data break-all text-[0.6875rem] text-cloud-400">
                Order {payment.orderId}
                {payment.paymentId ? ` · Payment ${payment.paymentId}` : ""}
              </p>
              {payment.failureReason ? <p className="text-[0.75rem] text-cloud-400">{payment.failureReason}</p> : null}
              {invoice ? (
                <div className="flex gap-2">
                  <Link href={`/dashboard/billing/invoices/${invoice.id}`} className="inline-flex h-9 flex-1 items-center justify-center gap-1.5 rounded-lg border border-ink-700 text-[0.8125rem] font-medium text-cloud-100">
                    <FileDown aria-hidden className="size-4" />
                    Download
                  </Link>
                  <Link href={`/dashboard/billing/invoices/${invoice.id}`} className="inline-flex h-9 flex-1 items-center justify-center gap-1.5 rounded-lg border border-ink-700 text-[0.8125rem] font-medium text-cloud-100">
                    <Eye aria-hidden className="size-4" />
                    View
                  </Link>
                </div>
              ) : (
                <p className="text-[0.75rem] text-cloud-400">No invoice available</p>
              )}
            </article>
          );
        })}
      </div>

      {filtered.length === 0 ? (
        <div className="border-t border-ink-700 px-5 py-12 text-center">
          <Search aria-hidden className="mx-auto size-6 text-cloud-400" />
          <p className="mt-3 text-[0.875rem] font-semibold text-cloud-100">
            {payments.length === 0 ? "No payments yet" : "No transactions found"}
          </p>
          <p className="mt-1 text-[0.8125rem] text-cloud-400">
            {payments.length === 0
              ? "Once you buy a plan, every payment appears here with its invoice."
              : "Try a different search or status filter."}
          </p>
        </div>
      ) : null}

      <div className="border-t border-ink-700 px-4 py-3 text-[0.75rem] text-cloud-400 sm:px-5">
        Showing {filtered.length} of {payments.length} transactions
      </div>
    </div>
  );
}
