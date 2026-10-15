import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";

import { NoRows, Panel, Td, TableShell, Th, Tr } from "@/components/admin/Panels";
import { UserActions, type UserSnapshot } from "@/components/admin/UserActions";
import { DataRow, PageHeading, StatTile } from "@/components/dashboard/PageHeading";
import { Badge, PaymentBadge, SubscriptionBadge } from "@/components/ui/Badge";
import { requireAdmin } from "@/lib/auth/guard";
import { countAdmins, findUserById, summariseUserFootprint } from "@/lib/db/accounts";
import { listAdminLogs } from "@/lib/db/admin";
import { listPayments, listSubscriptions } from "@/lib/db/billing";
import { formatDate, formatDateTime } from "@/lib/format";
import { formatINR, formatMoney } from "@/lib/money";
import { gatewayLabel } from "@/lib/payments";
import { listPlans } from "@/lib/plan-catalogue";
import { FEATURE_META } from "@/lib/plans";

export const dynamic = "force-dynamic";

/**
 * One account, everything about it, and every change an admin can make.
 *
 * The reading half is this server component; the writing half is
 * <UserActions>, which posts to /api/admin/users/[id]. That split keeps
 * the account's data out of the client bundle except for the handful of
 * fields the forms actually need.
 */
export default async function AdminUserDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const admin = await requireAdmin();
  const { id } = await params;

  const user = findUserById(id);
  if (!user) notFound();

  const subscriptions = listSubscriptions(user.id);
  const live = subscriptions.find((row) => row.status === "active") ?? null;
  const payments = listPayments(user.id);
  const footprint = summariseUserFootprint(user.id);
  const history = listAdminLogs({ targetId: user.id, limit: 25 });
  const plans = listPlans();

  const snapshot: UserSnapshot = {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    status: user.status,
    blockedReason: user.blockedReason,
    isSelf: user.id === admin.id,
    onlyAdmin: user.isAdmin && countAdmins() <= 1,
    subscription: live
      ? {
          id: live.id,
          planId: live.planId,
          planName: live.planName,
          status: live.status,
          scanLimit: live.scanLimit,
          scansUsed: live.scansUsed,
          siteLimit: live.siteLimit,
          expiresAt: live.expiresAt,
          adminNote: live.adminNote,
        }
      : null,
    plans: plans.map((plan) => ({
      id: plan.id,
      name: plan.name,
      summary: `${plan.amountPaise === 0 ? "free" : `${formatINR(plan.amountPaise)}/mo`}, ${plan.scanLimit} scans, ${plan.siteLimit} site${plan.siteLimit === 1 ? "" : "s"}`,
    })),
    footprint,
  };

  return (
    <div className="space-y-6">
      <Link
        href="/admin/users"
        className="inline-flex items-center gap-1.5 text-[0.8125rem] text-cloud-400 transition-colors hover:text-cloud-200"
      >
        <ArrowLeft className="size-3.5" aria-hidden />
        All users
      </Link>

      <PageHeading
        eyebrow={user.role === "admin" ? "Administrator" : "Customer"}
        title={user.name}
        lede={user.email}
        action={
          <div className="flex flex-wrap gap-2">
            {user.status === "active" ? (
              <Badge tone="pass" dot>
                Active
              </Badge>
            ) : (
              <Badge tone="fail" dot>
                Suspended
              </Badge>
            )}
            {user.role === "admin" ? <Badge tone="brand">Admin</Badge> : null}
          </div>
        }
      />

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatTile
          label="Scans this month"
          value={live ? `${live.scansUsed} / ${live.scanLimit}` : "—"}
          tone={live && live.isCapped ? "warn" : "default"}
          hint={live ? `Resets ${formatDate(live.cycleEnd)}` : "No subscription"}
        />
        <StatTile
          label="Websites"
          value={footprint.websites}
          hint={live?.siteLimit != null ? `Limit ${live.siteLimit}` : undefined}
        />
        <StatTile label="Reports" value={footprint.reports} />
        <StatTile
          label="Sessions"
          value={footprint.sessions}
          hint={footprint.sessions > 0 ? "Signed in somewhere" : "Not signed in"}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Account">
          <dl>
            <DataRow label="Account id" mono>
              {user.id}
            </DataRow>
            <DataRow label="Registered">{formatDateTime(user.createdAt)}</DataRow>
            <DataRow label="Last activity">
              {user.lastActiveAt ? formatDateTime(user.lastActiveAt) : "Never"}
            </DataRow>
            <DataRow label="Status">
              {user.status === "active" ? "Active" : "Suspended"}
            </DataRow>
            {user.blockedAt ? (
              <DataRow label="Suspended on">{formatDateTime(user.blockedAt)}</DataRow>
            ) : null}
            {user.blockedReason ? (
              <DataRow label="Reason">{user.blockedReason}</DataRow>
            ) : null}
            <DataRow label="Role">
              {user.role === "admin" ? "Administrator" : "Customer"}
            </DataRow>
          </dl>
        </Panel>

        <Panel title="Live subscription">
          {live ? (
            <dl>
              <DataRow label="Plan">
                {live.planName}
                {live.billingCycle === "yearly" ? " · billed yearly" : " · billed monthly"}
                {live.nextBillingCycle ? ` (→ ${live.nextBillingCycle} at renewal)` : ""}
              </DataRow>
              <DataRow label="Price paid" mono>
                {live.amountPaise === 0 ? "Free" : formatMoney(live.amountPaise, live.currency)}
              </DataRow>
              <DataRow label="Status">
                <SubscriptionBadge status={live.status} />
              </DataRow>
              <DataRow label="Payment">{live.paymentStatus}</DataRow>
              <DataRow label="Started">{formatDate(live.startsAt)}</DataRow>
              <DataRow label="Expires">
                {formatDate(live.expiresAt)}
                {live.isExpired ? " (passed)" : ` · ${live.daysRemaining} days left`}
              </DataRow>
              <DataRow label="Month resets">{formatDate(live.cycleEnd)}</DataRow>
              <DataRow label="Billing month" mono>
                #{live.cycleIndex}
              </DataRow>
              <DataRow label="Gateway">
                {live.gateway ? gatewayLabel(live.gateway) : "—"}
              </DataRow>
              {live.adminNote ? (
                <DataRow label="Note">{live.adminNote}</DataRow>
              ) : null}
            </dl>
          ) : (
            <NoRows>No active subscription.</NoRows>
          )}

          {live && live.features.length > 0 ? (
            <div className="mt-4 border-t border-ink-700 pt-4">
              <p className="text-[0.8125rem] font-medium text-cloud-600">
                Features sold with this subscription
              </p>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {live.features.map((feature) => (
                  <Badge key={feature} tone="neutral">
                    {FEATURE_META[feature].label}
                  </Badge>
                ))}
              </div>
              <p className="mt-2 text-[0.75rem] leading-snug text-cloud-600">
                Snapshotted at purchase. Editing the plan later does not take a
                feature away from a subscription already sold with it.
              </p>
            </div>
          ) : null}
        </Panel>
      </div>

      <UserActions user={snapshot} />

      {/* ── history ────────────────────────────────────────────── */}
      <Panel
        title="Subscription history"
        description="Every subscription row this account has ever had, newest first."
      >
        {subscriptions.length === 0 ? (
          <NoRows>Nothing yet.</NoRows>
        ) : (
          <TableShell
            head={
              <>
                <Th>Plan</Th>
                <Th>Price</Th>
                <Th>Status</Th>
                <Th>Payment</Th>
                <Th>Purchased</Th>
                <Th>Expires</Th>
                <Th>Scans</Th>
              </>
            }
          >
            {subscriptions.map((row) => (
              <Tr key={row.id}>
                <Td>{row.planName}</Td>
                <Td mono>{row.amountPaise === 0 ? "Free" : formatMoney(row.amountPaise, row.currency)}</Td>
                <Td>
                  <SubscriptionBadge status={row.status} />
                </Td>
                <Td mono>{row.paymentStatus}</Td>
                <Td mono>{formatDate(row.purchasedAt)}</Td>
                <Td mono>{formatDate(row.expiresAt)}</Td>
                <Td mono>
                  {row.scansUsed} / {row.scanLimit}
                </Td>
              </Tr>
            ))}
          </TableShell>
        )}
      </Panel>

      <Panel
        title="Payments"
        description="Mock-mode rows exist so checkout can be exercised without live keys, and are marked as such."
      >
        {payments.length === 0 ? (
          <NoRows>No payment has been attempted.</NoRows>
        ) : (
          <TableShell
            head={
              <>
                <Th>Date</Th>
                <Th>Plan</Th>
                <Th>Amount</Th>
                <Th>Status</Th>
                <Th>Gateway</Th>
                <Th>Order</Th>
                <Th>Reason</Th>
              </>
            }
          >
            {payments.map((payment) => (
              <Tr key={payment.id}>
                <Td mono>{formatDate(payment.createdAt)}</Td>
                <Td>{payment.planId}</Td>
                <Td mono>{formatMoney(payment.amountPaise, payment.currency)}</Td>
                <Td>
                  <PaymentBadge status={payment.status} />
                </Td>
                <Td>
                  <span className="flex items-center gap-1.5">
                    {gatewayLabel(payment.gateway)}
                    {payment.mode === "mock" ? (
                      <Badge tone="warn">Mock</Badge>
                    ) : payment.environment === "sandbox" ? (
                      <Badge tone="warn">Sandbox</Badge>
                    ) : null}
                  </span>
                </Td>
                <Td mono className="max-w-[12rem] truncate">
                  {payment.orderId}
                </Td>
                <Td className="max-w-[14rem] truncate text-cloud-600">
                  {payment.failureReason ?? "—"}
                </Td>
              </Tr>
            ))}
          </TableShell>
        )}
      </Panel>

      <Panel
        title="Administrative history"
        description="Changes made to this account by an administrator. Rows are never edited or deleted."
      >
        {history.length === 0 ? (
          <NoRows>No administrative change has been made to this account.</NoRows>
        ) : (
          <ul className="divide-y divide-ink-850">
            {history.map((entry) => (
              <li key={entry.id} className="py-3 first:pt-0 last:pb-0">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <p className="t-data text-[0.8125rem] text-cloud-200">
                    {entry.action}
                  </p>
                  <p className="t-data text-[0.75rem] text-cloud-600">
                    {formatDateTime(entry.createdAt)}
                  </p>
                </div>
                <p className="mt-1 text-[0.8125rem] leading-snug text-cloud-400">
                  {entry.detail ?? "—"}
                </p>
                <p className="mt-0.5 text-[0.75rem] text-cloud-600">
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
