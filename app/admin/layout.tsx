import { AdminShell } from "@/components/admin/AdminShell";
import { ToastProvider } from "@/components/ui/Toast";
import { requireAdmin } from "@/lib/auth/guard";
import { settleBilling } from "@/lib/db/billing";
import { failStaleReports } from "@/lib/db/audits";
import { totalUnreadForStaff } from "@/lib/chat/service";

/**
 * The gate on the whole panel.
 *
 * `requireAdmin()` sends an anonymous visitor to the login page and shows
 * a signed-in customer a 404 — there is no reason to confirm to them that
 * /admin exists. middleware.ts has already turned away requests with no
 * session cookie, but a cookie proves nothing; this is the check that
 * counts, and it runs before any child renders.
 */
export const dynamic = "force-dynamic";

export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const admin = await requireAdmin();

  // The same housekeeping the dashboard does on entry, so an operator is
  // never looking at a stale figure: roll billing months that have
  // elapsed, retire subscriptions past their expiry, and close out
  // reports whose run died with the process holding them.
  settleBilling();
  failStaleReports();

  return (
    <ToastProvider>
      <AdminShell
        admin={{ name: admin.name, email: admin.email, avatarUrl: admin.avatarUrl }}
        chatUnread={totalUnreadForStaff()}
      >
        {children}
      </AdminShell>
    </ToastProvider>
  );
}
