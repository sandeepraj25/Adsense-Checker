import type { Metadata } from "next";

import { Panel } from "@/components/admin/Panels";
import { PasswordForm } from "@/components/account/PasswordForm";
import { ADMIN_PROFILE_ENDPOINTS, ProfileForm } from "@/components/account/ProfileForm";
import { SessionsPanel } from "@/components/account/SessionsPanel";
import { DataRow, PageHeading } from "@/components/dashboard/PageHeading";
import { requireAdmin } from "@/lib/auth/guard";
import { countSessions } from "@/lib/db/accounts";
import { formatDate } from "@/lib/format";

export const metadata: Metadata = {
  title: "My account — Admin",
};

export const dynamic = "force-dynamic";

/**
 * The administrator's own profile. It edits only the signed-in admin's
 * row (through /api/admin/profile, which re-checks the admin role), and
 * deliberately offers no role or status controls: those stay on the user
 * management screens, where every change is written to the audit log.
 */
export default async function AdminAccountPage() {
  const admin = await requireAdmin();
  const sessions = countSessions(admin.id);

  return (
    <div className="flex flex-col gap-6">
      <PageHeading
        eyebrow="Administrator"
        title="My account"
        lede="Your name and photo appear in the admin panel and in the audit log entries you create."
      />

      <Panel title="Profile" description="Changes apply to your account only.">
        <ProfileForm
          name={admin.name}
          email={admin.email}
          avatarUrl={admin.avatarUrl}
          endpoints={ADMIN_PROFILE_ENDPOINTS}
        />
      </Panel>

      <div className="grid gap-6 lg:grid-cols-2">
        <Panel title="Password" description="Changing it signs out every other device.">
          <PasswordForm />
        </Panel>

        <div className="flex flex-col gap-6">
          <Panel title="Active sessions">
            <SessionsPanel count={sessions} />
          </Panel>

          <Panel title="Account">
            <dl>
              <DataRow label="Role">Administrator</DataRow>
              <DataRow label="Member since">{formatDate(admin.createdAt)}</DataRow>
              <DataRow label="Account ID" mono>
                {admin.id}
              </DataRow>
            </dl>
          </Panel>
        </div>
      </div>
    </div>
  );
}
