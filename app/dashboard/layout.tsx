import { ShieldAlert } from "lucide-react";

import { DashboardShell, type ShellPlan } from "@/components/dashboard/DashboardShell";
import { ToastProvider } from "@/components/ui/Toast";
import { requireUser } from "@/lib/auth/guard";
import { expireStaleSubscriptions, getActiveSubscription } from "@/lib/db/billing";
import { failStaleReports } from "@/lib/db/audits";
import { accountBlock } from "@/lib/entitlement";

/**
 * Every /dashboard route is gated here. middleware.ts turns away
 * requests with no session cookie, but a cookie proves nothing — this is
 * the authoritative check, and it runs before any child renders.
 */
export const dynamic = "force-dynamic";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await requireUser();

  // Housekeeping on entry: retire plans that ran out of validity, and
  // close out any report whose run died with the process holding it.
  expireStaleSubscriptions();
  failStaleReports();

  const subscription = getActiveSubscription(user.id);
  const plan: ShellPlan = subscription
    ? {
        planName: subscription.planName,
        scansUsed: subscription.scansUsed,
        scanLimit: subscription.scanLimit,
        isUsable: subscription.isUsable,
      }
    : null;

  // Suspension is enforced in three other places already — blocking an
  // account deletes its sessions, the login route refuses it, and every
  // mutating API route re-reads the row. This is the fourth: the status is
  // read from the database on every navigation, so if a row is ever
  // blocked while a session survives (a direct SQL edit, a future code
  // path that forgets to clear sessions), the customer gets the reason in
  // plain language instead of a dashboard that half works. It replaces the
  // page body rather than sitting above it, because a suspended account
  // must not reach paid features from the UI either.
  const blocked = accountBlock(user);

  return (
    <ToastProvider>
      <DashboardShell
        user={{ name: user.name, email: user.email, avatarUrl: user.avatarUrl }}
        plan={plan}
      >
        {blocked ? <Suspended message={blocked.message} /> : children}
      </DashboardShell>
    </ToastProvider>
  );
}

function Suspended({ message }: { message: string }) {
  return (
    <div className="glass edge-light rounded-xl p-6 sm:p-8">
      <span className="grid size-11 place-items-center rounded-xl border border-rose-400/25 bg-rose-400/[0.07]">
        <ShieldAlert className="size-5 text-rose-400" aria-hidden />
      </span>

      <p className="t-eyebrow mt-5 text-cloud-600">Account suspended</p>
      <h1 className="t-display mt-2 text-[1.5rem] leading-tight text-cloud-50">
        This account is suspended
      </h1>
      <p className="mt-3 max-w-xl text-[0.9375rem] leading-relaxed text-cloud-400">
        {message}
      </p>
      <p className="mt-3 max-w-xl text-[0.875rem] leading-relaxed text-cloud-600">
        New scans, plan changes and paid features are unavailable while the
        suspension is in place. Nothing has been deleted — your reports and
        billing history are intact and will be here when it is lifted.
      </p>
    </div>
  );
}
