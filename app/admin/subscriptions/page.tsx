import Link from "next/link";
import {
  CreditCard,
  ShieldCheck,
} from "lucide-react";

import {
  FilterGroup,
  FilterTabs,
  NoRows,
  Panel,
  StatGrid,
  Td,
  TableShell,
  Th,
  Tr,
} from "@/components/admin/Panels";
import { PageHeading, StatTile } from "@/components/dashboard/PageHeading";
import { Badge, SubscriptionBadge } from "@/components/ui/Badge";
import {
  adminStats,
  listAllPayments,
  listAllSubscriptions,
} from "@/lib/db/admin";
import {
  GATEWAY_IDS,
  type SubscriptionPaymentStatus,
} from "@/lib/db/types";
import { formatDate, formatDateTime } from "@/lib/format";
import { formatMoney } from "@/lib/money";
import { gatewayLabel } from "@/lib/payments";
import { isPlanId, type PlanId } from "@/lib/plans";

export const dynamic = "force-dynamic";

export const metadata = { title: "Subscriptions — Admin" };

const ROWS = 100;

export default async function AdminSubscriptionsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;

  const statusParam = single(params.status);
  const status =
    statusParam === "active" ||
    statusParam === "expired" ||
    statusParam === "cancelled"
      ? statusParam
      : undefined;

  const planParam = single(params.plan);
  const plan: PlanId | undefined = isPlanId(planParam)
    ? planParam
    : undefined;

  const gatewayParam = single(params.gateway);
  const gateway = (GATEWAY_IDS as readonly string[]).includes(gatewayParam)
    ? gatewayParam
    : undefined;

  const payParam = single(params.payment);
  const paymentStatus =
    payParam === "paid" ||
    payParam === "failed" ||
    payParam === "created" ||
    payParam === "cancelled"
      ? payParam
      : undefined;

  const subscriptions = listAllSubscriptions({
    ...(status ? { status } : {}),
    ...(plan ? { planId: plan } : {}),
    limit: ROWS,
  });

  const payments = listAllPayments({
    ...(paymentStatus ? { status: paymentStatus } : {}),
    ...(gateway ? { gateway } : {}),
    limit: ROWS,
  });

  const stats = adminStats();

  const subHref = (patch: Record<string, string | undefined>) =>
    build({
      status: status ?? "",
      plan: plan ?? "",
      gateway: gateway ?? "",
      payment: paymentStatus ?? "",
      ...patch,
    });

  const payHref = subHref;

  return (
    <div className="space-y-6">
      {/* PAGE HEADER */}
      <PageHeading
        eyebrow="Administration"
        title="Subscriptions & payments"
        lede="Active plans, payment attempts and verified revenue."
      />

      <StatGrid>
        <StatTile label="Active subscriptions" value={stats.subscriptions.active} hint="Currently active accounts" />
        <StatTile label="Expired subscriptions" value={stats.subscriptions.expired} hint="Billing period ended" tone={stats.subscriptions.expired > 0 ? "warn" : "default"} />
        <StatTile label="Cancelled subscriptions" value={stats.subscriptions.cancelled} hint="Plan access ended early" />
        <StatTile
          label="Verified revenue"
          value={formatMoney(stats.revenueByCurrency.INR, "INR")}
          hint={`${stats.revenueByCurrency.USD > 0 ? `+ ${formatMoney(stats.revenueByCurrency.USD, "USD")} · ` : ""}${stats.payments.paid} paid · ${stats.payments.failed} failed`}
        />
      </StatGrid>

      <Panel
        title="Subscriptions"
        description="Customer plans, billing cycles and monthly scan usage. Allowances reset on the date shown."
        action={<Badge>{subscriptions.length} shown</Badge>}
      >
        <div className="-mx-5 -mt-4 mb-4 space-y-3 border-b border-ink-700 bg-ink-900 px-5 py-4">
          <FilterGroup label="Status">
            <FilterTabs
              current={status ?? "all"}
              options={[
                {
                  label: "All",
                  value: "all",
                  href: subHref({ status: undefined }),
                },
                {
                  label: "Active",
                  value: "active",
                  href: subHref({ status: "active" }),
                  count: stats.subscriptions.active,
                },
                {
                  label: "Expired",
                  value: "expired",
                  href: subHref({ status: "expired" }),
                  count: stats.subscriptions.expired,
                },
                {
                  label: "Cancelled",
                  value: "cancelled",
                  href: subHref({ status: "cancelled" }),
                  count: stats.subscriptions.cancelled,
                },
              ]}
            />
          </FilterGroup>
          <FilterGroup label="Plan">
            <FilterTabs
              current={plan ?? "any"}
              options={[
                {
                  label: "Any plan",
                  value: "any",
                  href: subHref({ plan: undefined }),
                },
                {
                  label: "Free",
                  value: "free",
                  href: subHref({ plan: "free" }),
                  count: stats.plans.free,
                },
                {
                  label: "Basic",
                  value: "basic",
                  href: subHref({ plan: "basic" }),
                  count: stats.plans.basic,
                },
                {
                  label: "Pro",
                  value: "pro",
                  href: subHref({ plan: "pro" }),
                  count: stats.plans.pro,
                },
              ]}
            />
          </FilterGroup>
        </div>

        {/* TABLE */}
        <div>
          {subscriptions.length === 0 ? (
            <NoRows>No subscription matches those filters.</NoRows>
          ) : (
            <TableShell
              head={
                <>
                  <Th>Account</Th>
                  <Th>Plan</Th>
                  <Th>Paid</Th>
                  <Th>Status</Th>
                  <Th>Payment</Th>
                  <Th>Gateway</Th>
                  <Th>Started</Th>
                  <Th>Renews / ends</Th>
                  <Th>Scans</Th>
                </>
              }
            >
              {subscriptions.map((row) => (
                <Tr key={row.id}>
                  <Td>
                    <Link
                      href={`/admin/users/${row.userId}`}
                      className="block min-w-[11rem] transition-opacity hover:opacity-80"
                    >
                      <span className="block text-sm font-medium text-cloud-50">
                        {row.userName}
                      </span>

                      <span className="mt-1 block truncate text-xs text-cloud-500">
                        {row.userEmail}
                      </span>
                    </Link>
                  </Td>

                  <Td>
                    <span className="font-medium text-cloud-100">
                      {row.planName}
                    </span>
                  </Td>

                  <Td mono>
                    <span className="font-medium text-cloud-100">
                      {row.amountPaise === 0
                        ? "Free"
                        : formatMoney(row.amountPaise, row.currency)}
                    </span>
                  </Td>

                  <Td>
                    <span className="flex items-center gap-1.5">
                      <SubscriptionBadge status={row.status} />

                      {row.status === "active" && row.isExpired ? (
                        <Badge tone="warn">Lapsed</Badge>
                      ) : null}

                      {row.isCapped ? (
                        <Badge tone="warn">Capped</Badge>
                      ) : null}
                    </span>
                  </Td>

                  <Td>
                    <SubPaymentBadge status={row.paymentStatus} />
                  </Td>

                  <Td>
                    <span className="text-sm text-cloud-200">
                      {row.gateway
                        ? gatewayLabel(row.gateway)
                        : "—"}
                    </span>
                  </Td>

                  <Td mono>
                    <span className="text-sm text-cloud-200">
                      {formatDate(row.startsAt)}
                    </span>
                  </Td>

                  <Td mono>
                    <span className="text-sm text-cloud-200">
                      {formatDate(row.expiresAt)}
                    </span>

                    <span className="mt-1 block max-w-[12rem] text-[0.75rem] leading-relaxed text-cloud-400">
                      {row.isExpired
                        ? "Billing period passed"
                        : `Cycle #${row.cycleIndex} · resets ${formatDate(
                            row.cycleEnd,
                          )}`}
                    </span>
                  </Td>

                  <Td mono>
                    <span
                      className={`font-medium ${
                        row.isCapped
                          ? "text-amber-400"
                          : "text-cloud-200"
                      }`}
                    >
                      {row.scansUsed} / {row.scanLimit}
                    </span>
                  </Td>
                </Tr>
              ))}
            </TableShell>
          )}
        </div>
      </Panel>

      <Panel
        title="Payments"
        description="Every payment attempt, including paid, failed, pending, sandbox and test transactions."
        action={<Badge>{payments.length} shown</Badge>}
      >
        <div className="-mx-5 -mt-4 mb-4 space-y-3 border-b border-ink-700 bg-ink-900 px-5 py-4">
          <FilterGroup label="Status">
            <FilterTabs
              current={paymentStatus ?? "all"}
              options={[
                {
                  label: "All",
                  value: "all",
                  href: payHref({ payment: undefined }),
                },
                {
                  label: "Paid",
                  value: "paid",
                  href: payHref({ payment: "paid" }),
                  count: stats.payments.paid,
                },
                {
                  label: "Awaiting",
                  value: "created",
                  href: payHref({ payment: "created" }),
                },
                {
                  label: "Failed",
                  value: "failed",
                  href: payHref({ payment: "failed" }),
                },
                {
                  label: "Cancelled",
                  value: "cancelled",
                  href: payHref({ payment: "cancelled" }),
                },
              ]}
            />
          </FilterGroup>
          <FilterGroup label="Gateway">
            <FilterTabs
              current={gateway ?? "any"}
              options={[
                {
                  label: "Any gateway",
                  value: "any",
                  href: payHref({ gateway: undefined }),
                },
                ...GATEWAY_IDS.map((id) => ({
                  label: gatewayLabel(id),
                  value: id,
                  href: payHref({ gateway: id }),
                })),
              ]}
            />
          </FilterGroup>
        </div>

        {/* PAYMENT TABLE */}
        <div>
          {payments.length === 0 ? (
            <NoRows>No payment matches those filters.</NoRows>
          ) : (
            <TableShell
              head={
                <>
                  <Th>When</Th>
                  <Th>Account</Th>
                  <Th>Plan</Th>
                  <Th>Amount</Th>
                  <Th>Status</Th>
                  <Th>Gateway</Th>
                  <Th>Order</Th>
                  <Th>Verified</Th>
                  <Th>Reason</Th>
                </>
              }
            >
              {payments.map((payment) => (
                <Tr key={payment.id}>
                  <Td mono>
                    <span className="text-xs text-cloud-300">
                      {formatDateTime(payment.createdAt)}
                    </span>
                  </Td>

                  <Td>
                    <span className="block min-w-[11rem] text-sm font-medium text-cloud-50">
                      {payment.userName}
                    </span>

                    <span className="mt-1 block truncate text-xs text-cloud-500">
                      {payment.userEmail}
                    </span>
                  </Td>

                  <Td>
                    <span className="font-medium text-cloud-100">
                      {payment.planId}
                    </span>
                  </Td>

                  <Td mono>
                    <span className="font-medium text-cloud-100">
                      {formatMoney(payment.amountPaise, payment.currency)}
                    </span>
                  </Td>

                  <Td>
                    <PayBadge status={payment.status} />
                  </Td>

                  <Td>
                    <span className="flex items-center gap-1.5">
                      <CreditCard className="h-3.5 w-3.5 text-cloud-500" />

                      <span className="text-sm text-cloud-200">
                        {gatewayLabel(payment.gateway)}
                      </span>

                      {payment.mode === "mock" ? (
                        <Badge tone="warn">Mock</Badge>
                      ) : payment.environment === "sandbox" ? (
                        <Badge tone="warn">Sandbox</Badge>
                      ) : null}
                    </span>
                  </Td>

                  <Td
                    mono
                    className="max-w-[12rem] truncate text-xs text-cloud-400"
                  >
                    {payment.orderId}
                  </Td>

                  <Td mono>
                    <span className="text-xs text-cloud-400">
                      {payment.verifiedAt
                        ? formatDateTime(payment.verifiedAt)
                        : "—"}
                    </span>
                  </Td>

                  <Td className="max-w-[14rem] truncate text-xs text-cloud-500">
                    {payment.failureReason ?? "—"}
                  </Td>
                </Tr>
              ))}
            </TableShell>
          )}

          <div className="mt-4 flex items-start gap-3 border-t border-ink-700 pt-4">
            <ShieldCheck className="mt-0.5 size-4 shrink-0 text-mint-400" aria-hidden />

            <p className="text-[0.875rem] leading-relaxed text-cloud-300">
              A subscription is activated only after the payment is verified by
              the payment gateway. Browser-reported success alone never grants
              plan access.
            </p>
          </div>
        </div>
      </Panel>
    </div>
  );
}

function SubPaymentBadge({
  status,
}: {
  status: SubscriptionPaymentStatus;
}) {
  if (status === "paid") {
    return <Badge tone="pass">Paid</Badge>;
  }

  if (status === "free") {
    return <Badge tone="neutral">Free</Badge>;
  }

  if (status === "pending") {
    return <Badge tone="warn">Pending</Badge>;
  }

  return <Badge tone="fail">Failed</Badge>;
}

function PayBadge({ status }: { status: string }) {
  if (status === "paid") {
    return <Badge tone="pass">Paid</Badge>;
  }

  if (status === "created") {
    return <Badge tone="warn">Awaiting</Badge>;
  }

  if (status === "failed") {
    return <Badge tone="fail">Failed</Badge>;
  }

  if (status === "cancelled") {
    return <Badge tone="neutral">Cancelled</Badge>;
  }

  return <Badge tone="neutral">{status}</Badge>;
}

function build(values: Record<string, string | undefined>): string {
  const next = new URLSearchParams();

  for (const [key, value] of Object.entries(values)) {
    if (value) {
      next.set(key, value);
    }
  }

  const query = next.toString();

  return query
    ? `/admin/subscriptions?${query}`
    : "/admin/subscriptions";
}

function single(value: string | string[] | undefined): string {
  return Array.isArray(value)
    ? (value[0] ?? "")
    : (value ?? "");
}