import type { Metadata } from "next";
import {
  Database,
  LockKeyhole,
  MonitorSmartphone,
  ShieldCheck,
  UserRound,
} from "lucide-react";

import { PasswordForm } from "@/components/account/PasswordForm";
import { ProfileForm } from "@/components/account/ProfileForm";
import { SessionsPanel } from "@/components/account/SessionsPanel";
import { DataRow, PageHeading } from "@/components/dashboard/PageHeading";
import { ButtonLink } from "@/components/ui/Button";
import { requireUser } from "@/lib/auth/guard";
import { countSessions } from "@/lib/db/accounts";
import { countReports, countWebsites } from "@/lib/db/audits";
import { getLatestSubscription } from "@/lib/db/billing";
import { formatDate } from "@/lib/format";

export const metadata: Metadata = {
  title: "Settings",
};

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const user = await requireUser();

  const sessions = countSessions(user.id);
  const reports = countReports(user.id);
  const websites = countWebsites(user.id);
  const subscription = getLatestSubscription(user.id);

  return (
    <div className="flex flex-col gap-6">
      <PageHeading
        eyebrow="Settings"
        title="Your account"
        lede="Manage your profile, password, signed-in devices and account information."
      />

      {/* ── Profile ── */}
      <section className={card}>
        <SectionTitle
          icon={UserRound}
          title="Profile"
          description="Your name and photo appear in your dashboard and navigation. Your name is also printed on invoices."
        />
        <div className="mt-6 border-t border-ink-700 pt-6">
          <ProfileForm name={user.name} email={user.email} avatarUrl={user.avatarUrl} />
        </div>
      </section>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* ── Sessions ── */}
        <section className={card}>
          <SectionTitle
            icon={MonitorSmartphone}
            title="Active devices"
            description="Every browser where you are signed in."
          />
          <div className="mt-5 border-t border-ink-700 pt-5">
            <SessionsPanel count={sessions} />
          </div>
        </section>

        {/* ── Account overview ── */}
        <section className={card}>
          <SectionTitle icon={ShieldCheck} title="Account overview" />

          <dl className="mt-4">
            <DataRow label="Member since">{formatDate(user.createdAt)}</DataRow>

            <DataRow label="Current plan">
              <span className="inline-flex items-center gap-2">
                <span aria-hidden className="size-1.5 rounded-full bg-mint-400" />
                {subscription?.planName ?? "Free"}
              </span>
            </DataRow>

            <DataRow label="Scans run">{reports}</DataRow>

            <DataRow label="Websites">{websites}</DataRow>

            <DataRow label="Account ID" mono>
              {user.id}
            </DataRow>
          </dl>

          <div className="mt-5 flex flex-wrap gap-2">
            <ButtonLink href="/dashboard/billing" variant="ghost" size="sm">
              Billing &amp; invoices
            </ButtonLink>
            <ButtonLink href="/dashboard/reports" variant="quiet" size="sm">
              Your reports
            </ButtonLink>
          </div>
        </section>
      </div>

      {/* ── Password ── */}
      <section className={card}>
        <div className="grid gap-6 lg:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)] lg:items-start">
          <SectionTitle
            icon={LockKeyhole}
            title="Password"
            description="Changing your password protects your account and signs out every other device."
          />
          <div className="rounded-xl border border-ink-700 bg-ink-900 p-5">
            <PasswordForm />
          </div>
        </div>
      </section>

      {/* ── Data ── */}
      <section className={card}>
        <SectionTitle icon={Database} title="Your data" />
        <div className="mt-4 max-w-3xl space-y-3">
          <p className="text-[0.9375rem] leading-relaxed text-cloud-200">
            We store your name, email, an optional profile photo, a one-way
            hash of your password, the domains you have scanned and the
            reports produced from them. Payment card and UPI details are
            handled by the payment provider and are never sent to this
            application.
          </p>

          <p className="text-[0.875rem] leading-relaxed text-cloud-400">
            To delete your account and everything attached to it, email the
            address on the invoice. Deleting a single report is immediate —
            the delete button on any report removes it permanently.
          </p>
        </div>
      </section>
    </div>
  );
}

const card = "rounded-xl border border-ink-700 bg-white p-5 shadow-[0_1px_2px_rgba(24,24,27,0.04)] sm:p-6";

function SectionTitle({
  icon: Icon,
  title,
  description,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  description?: string;
}) {
  return (
    <div className="flex items-start gap-3">
      <span className="grid size-9 shrink-0 place-items-center rounded-lg border border-ink-700 bg-ink-900 text-cloud-300">
        <Icon className="size-[1.05rem]" />
      </span>
      <div className="min-w-0">
        <h2 className="text-[1.0625rem] font-semibold text-cloud-50">{title}</h2>
        {description ? (
          <p className="mt-1 max-w-xl text-[0.875rem] leading-relaxed text-cloud-400">
            {description}
          </p>
        ) : null}
      </div>
    </div>
  );
}
