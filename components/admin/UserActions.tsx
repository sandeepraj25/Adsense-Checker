"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  ArrowUpDown,
  CalendarClock,
  Gauge,
  RotateCcw,
  ShieldCheck,
  Trash2,
  UserCog,
} from "lucide-react";

import { Panel } from "@/components/admin/Panels";
import { Button } from "@/components/ui/Button";
import { Field, FormAlert } from "@/components/ui/Field";
import { Spinner } from "@/components/ui/Spinner";
import { useToast } from "@/components/ui/Toast";

/**
 * Every administrative change to one account, in one place.
 *
 * These forms are convenience, not control. Each one posts to
 * /api/admin/users/[id], and that endpoint re-checks that the caller is an
 * administrator, re-validates every value and refuses the dangerous cases
 * — self-suspension, self-demotion, removing the last administrator —
 * regardless of what this component chose to render. Disabling a button
 * here is a courtesy to the operator, not a security boundary.
 *
 * After a successful change the server components are refreshed rather
 * than the local state patched: the panel should show what the database
 * says, not what this form hoped would happen.
 */

export type UserSnapshot = {
  id: string;
  name: string;
  email: string;
  role: "user" | "admin";
  status: "active" | "blocked";
  blockedReason: string | null;
  /** The signed-in admin is looking at their own account. */
  isSelf: boolean;
  /** This is the only administrator left. */
  onlyAdmin: boolean;
  subscription: {
    id: string;
    planId: string;
    planName: string;
    status: string;
    scanLimit: number;
    scansUsed: number;
    siteLimit: number | null;
    expiresAt: number;
    adminNote: string | null;
  } | null;
  plans: { id: string; name: string; summary: string }[];
  footprint: {
    websites: number;
    reports: number;
    subscriptions: number;
    payments: number;
    invoices: number;
    sessions: number;
  };
};

/** IST end-of-day, matching the timezone every date in the app renders in. */
function endOfDayIST(date: string): number | null {
  const parsed = Date.parse(`${date}T23:59:59+05:30`);
  return Number.isFinite(parsed) ? parsed : null;
}

function dateInputValue(ms: number): string {
  // Shift into IST before slicing, so a date that reads "04 Mar" in the
  // panel does not arrive in the input as the 3rd.
  return new Date(ms + 5.5 * 3_600_000).toISOString().slice(0, 10);
}

export function UserActions({ user }: { user: UserSnapshot }) {
  const router = useRouter();
  const { success, error } = useToast();
  const [busy, setBusy] = useState<string | null>(null);

  const [name, setName] = useState(user.name);
  const [email, setEmail] = useState(user.email);
  const [reason, setReason] = useState("");
  const [planId, setPlanId] = useState(user.subscription?.planId ?? "free");
  const [months, setMonths] = useState("1");
  const [expiry, setExpiry] = useState(
    user.subscription ? dateInputValue(user.subscription.expiresAt) : "",
  );
  const [scanLimit, setScanLimit] = useState(
    user.subscription ? String(user.subscription.scanLimit) : "",
  );
  const [siteLimit, setSiteLimit] = useState(
    user.subscription?.siteLimit != null ? String(user.subscription.siteLimit) : "",
  );
  const [note, setNote] = useState(user.subscription?.adminNote ?? "");
  const [confirmEmail, setConfirmEmail] = useState("");

  async function send(
    key: string,
    body: Record<string, unknown>,
    done: string,
  ): Promise<boolean> {
    if (busy) return false;
    setBusy(key);
    try {
      const res = await fetch(`/api/admin/users/${user.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data: unknown = await res.json().catch(() => null);
      const payload = (data ?? {}) as { ok?: boolean; message?: string };
      if (!res.ok || !payload.ok) {
        error(
          "Not applied",
          payload.message ?? "The change was refused. Nothing was saved.",
        );
        return false;
      }
      success(done);
      router.refresh();
      return true;
    } catch {
      error("Could not reach the server", "Check your connection and try again.");
      return false;
    } finally {
      setBusy(null);
    }
  }

  async function remove() {
    if (busy) return;
    setBusy("delete");
    try {
      const res = await fetch(`/api/admin/users/${user.id}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirmEmail }),
      });
      const data: unknown = await res.json().catch(() => null);
      const payload = (data ?? {}) as { ok?: boolean; message?: string };
      if (!res.ok || !payload.ok) {
        error("Not deleted", payload.message ?? "The account was not deleted.");
        setBusy(null);
        return;
      }
      success("Account deleted", `${user.email} and everything it owned.`);
      router.push("/admin/users");
      router.refresh();
    } catch {
      error("Could not reach the server", "Nothing was deleted.");
      setBusy(null);
    }
  }

  const working = (key: string) => busy === key;

  return (
    <div className="space-y-4">
      {/* ── identity ───────────────────────────────────────────── */}
      <Panel
        title="Profile"
        description="Changing the email address changes the address this person signs in with. Tell them before you do it."
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <Field
            label="Name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            autoComplete="off"
          />
          <Field
            label="Email"
            type="email"
            mono
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            autoComplete="off"
          />
        </div>
        <div className="mt-4">
          <Button
            size="sm"
            variant="ghost"
            disabled={busy !== null || (name === user.name && email === user.email)}
            onClick={() => void send("profile", { action: "profile", name, email }, "Profile updated")}
          >
            {working("profile") ? <Spinner className="size-4" /> : <UserCog className="size-4" />}
            Save profile
          </Button>
        </div>
      </Panel>

      {/* ── plan ───────────────────────────────────────────────── */}
      <Panel
        title="Plan"
        description="Assigning a plan here creates a new subscription with no charge and supersedes the current one. The old row stays in the billing history."
      >
        <div className="grid gap-3 sm:grid-cols-[1fr_10rem]">
          <label className="flex flex-col gap-1.5">
            <span className="text-[0.8125rem] font-medium text-cloud-200">Plan</span>
            <select
              value={planId}
              onChange={(event) => setPlanId(event.target.value)}
              className="h-11 rounded-lg border border-ink-700 bg-white px-3 text-[0.9375rem] text-cloud-50 outline-none transition-colors hover:border-zinc-300 focus:border-azure-500 focus:ring-3 focus:ring-azure-500/15"
            >
              {user.plans.map((plan) => (
                <option key={plan.id} value={plan.id}>
                  {plan.name} — {plan.summary}
                </option>
              ))}
            </select>
          </label>

          <Field
            label="Months"
            type="number"
            min={1}
            max={36}
            value={months}
            onChange={(event) => setMonths(event.target.value)}
            hint="1–36"
          />
        </div>

        <div className="mt-4">
          <Button
            size="sm"
            disabled={busy !== null}
            onClick={() =>
              void send(
                "plan",
                { action: "plan", planId, months },
                `Moved to ${user.plans.find((plan) => plan.id === planId)?.name ?? planId}`,
              )
            }
          >
            {working("plan") ? <Spinner className="size-4" /> : <ArrowUpDown className="size-4" />}
            Apply plan
          </Button>
        </div>
      </Panel>

      {/* ── subscription adjustments ───────────────────────────── */}
      {user.subscription ? (
        <Panel
          title="Subscription"
          description="These edit the live subscription in place. Usage is per billing month and resets on its own at the renewal date."
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <Field
                label="Expires on"
                type="date"
                value={expiry}
                onChange={(event) => setExpiry(event.target.value)}
                hint="End of day, IST"
              />
              <div className="mt-2 flex flex-wrap gap-1.5">
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy !== null}
                  onClick={() => {
                    const at = endOfDayIST(expiry);
                    if (at === null) {
                      error("Pick a date first");
                      return;
                    }
                    void send("expiry", { action: "expiry", expiresAt: at }, "Expiry updated");
                  }}
                >
                  {working("expiry") ? <Spinner className="size-4" /> : <CalendarClock className="size-4" />}
                  Set date
                </Button>
                {[7, 30, 90].map((days) => (
                  <Button
                    key={days}
                    size="sm"
                    variant="ghost"
                    disabled={busy !== null}
                    onClick={() =>
                      void send(
                        `extend-${days}`,
                        { action: "expiry", days },
                        `Extended by ${days} days`,
                      )
                    }
                  >
                    {working(`extend-${days}`) ? <Spinner className="size-4" /> : null}
                    +{days}d
                  </Button>
                ))}
              </div>
            </div>

            <div>
              <div className="grid grid-cols-2 gap-3">
                <Field
                  label="Scans / month"
                  type="number"
                  min={1}
                  value={scanLimit}
                  onChange={(event) => setScanLimit(event.target.value)}
                />
                <Field
                  label="Websites"
                  type="number"
                  min={1}
                  value={siteLimit}
                  onChange={(event) => setSiteLimit(event.target.value)}
                />
              </div>
              <div className="mt-2 flex flex-wrap gap-1.5">
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy !== null}
                  onClick={() =>
                    void send(
                      "limits",
                      {
                        action: "limits",
                        ...(scanLimit ? { scanLimit } : {}),
                        ...(siteLimit ? { siteLimit } : {}),
                      },
                      "Limits updated",
                    )
                  }
                >
                  {working("limits") ? <Spinner className="size-4" /> : <Gauge className="size-4" />}
                  Save limits
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy !== null}
                  onClick={() =>
                    void send(
                      "reset_usage",
                      { action: "reset_usage" },
                      "Usage reset for this month",
                    )
                  }
                >
                  {working("reset_usage") ? <Spinner className="size-4" /> : <RotateCcw className="size-4" />}
                  Reset usage ({user.subscription.scansUsed} used)
                </Button>
              </div>
            </div>
          </div>

          <div className="mt-5 grid gap-3 sm:grid-cols-2">
            <div>
              <p className="text-[0.8125rem] font-medium text-cloud-200">Status</p>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {(["active", "expired", "cancelled"] as const).map((status) => (
                  <Button
                    key={status}
                    size="sm"
                    variant={user.subscription?.status === status ? "primary" : "ghost"}
                    aria-pressed={user.subscription?.status === status}
                    disabled={busy !== null || user.subscription?.status === status}
                    onClick={() =>
                      void send(
                        `status-${status}`,
                        { action: "subscription_status", status },
                        `Subscription marked ${status}`,
                      )
                    }
                  >
                    {working(`status-${status}`) ? <Spinner className="size-4" /> : null}
                    {status}
                  </Button>
                ))}
              </div>
              <p className="mt-2 text-[0.75rem] leading-snug text-cloud-600">
                Reactivating needs an expiry date in the future — an “active”
                row that every entitlement check still refuses reads as a bug.
              </p>
            </div>

            <div>
              <Field
                label="Internal note"
                value={note}
                onChange={(event) => setNote(event.target.value)}
                hint="Visible to administrators only"
              />
              <div className="mt-2">
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy !== null}
                  onClick={() => void send("note", { action: "note", note }, "Note saved")}
                >
                  {working("note") ? <Spinner className="size-4" /> : null}
                  Save note
                </Button>
              </div>
            </div>
          </div>
        </Panel>
      ) : (
        <Panel title="Subscription" description="This account has no subscription row yet.">
          <FormAlert tone="info">
            Assign a plan above to create one. Free accounts normally get theirs
            on signup, so a missing row usually means the account predates that.
          </FormAlert>
        </Panel>
      )}

      {/* ── access ─────────────────────────────────────────────── */}
      <Panel
        title="Access"
        description="Suspending an account signs it out immediately and refuses new logins, scans and paid features until it is restored."
      >
        {user.status === "active" ? (
          <div className="space-y-3">
            <Field
              label="Reason (shown to the person at login)"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              hint="Optional. Written to the audit log either way."
            />
            <Button
              size="sm"
              variant="ghost"
              disabled={busy !== null || user.isSelf || (user.role === "admin" && user.onlyAdmin)}
              className="text-rose-400"
              onClick={() => void send("block", { action: "block", reason }, "Account suspended")}
            >
              {working("block") ? <Spinner className="size-4" /> : <AlertTriangle className="size-4" />}
              Suspend account
            </Button>
            {user.isSelf ? (
              <p className="text-[0.75rem] text-cloud-600">
                You cannot suspend your own account.
              </p>
            ) : null}
          </div>
        ) : (
          <div className="space-y-3">
            <FormAlert>
              Suspended
              {user.blockedReason ? ` — ${user.blockedReason}` : "."} This account
              cannot sign in.
            </FormAlert>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy !== null}
              onClick={() => void send("unblock", { action: "unblock" }, "Account restored")}
            >
              {working("unblock") ? <Spinner className="size-4" /> : <ShieldCheck className="size-4" />}
              Restore access
            </Button>
          </div>
        )}

        <div className="mt-5 border-t border-ink-700 pt-4">
          <p className="text-[0.8125rem] font-medium text-cloud-200">Role</p>
          <p className="mt-1 text-[0.75rem] leading-snug text-cloud-600">
            Administrators can see every account, re-price plans and hold
            payment credentials. Grant it deliberately.
          </p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            <Button
              size="sm"
              variant={user.role === "admin" ? "primary" : "ghost"}
              aria-pressed={user.role === "admin"}
              disabled={busy !== null || user.isSelf || user.role === "admin"}
              onClick={() => void send("promote", { action: "role", role: "admin" }, "Promoted to administrator")}
            >
              {working("promote") ? <Spinner className="size-4" /> : null}
              Make administrator
            </Button>
            <Button
              size="sm"
              variant={user.role === "user" ? "primary" : "ghost"}
              aria-pressed={user.role === "user"}
              disabled={busy !== null || user.isSelf || user.role === "user" || user.onlyAdmin}
              onClick={() => void send("demote", { action: "role", role: "user" }, "Demoted to customer")}
            >
              {working("demote") ? <Spinner className="size-4" /> : null}
              Make customer
            </Button>
          </div>
          {user.onlyAdmin ? (
            <p className="mt-2 text-[0.75rem] text-cloud-600">
              This is the only administrator account, so it cannot be demoted or
              suspended.
            </p>
          ) : null}
        </div>
      </Panel>

      {/* ── deletion ───────────────────────────────────────────── */}
      <Panel
        title="Delete account"
        description="Removes the account and everything hanging off it. The audit log keeps the record that it happened."
        className="border-rose-400/20"
      >
        <ul className="mb-4 grid gap-1 text-[0.8125rem] text-cloud-400 sm:grid-cols-2">
          <li>{user.footprint.reports} reports and their findings</li>
          <li>{user.footprint.websites} websites</li>
          <li>{user.footprint.subscriptions} subscriptions</li>
          <li>{user.footprint.payments} payments</li>
          <li>{user.footprint.invoices} invoices</li>
          <li>{user.footprint.sessions} active sessions</li>
        </ul>

        <div className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
          <Field
            label="Type the email address to confirm"
            mono
            value={confirmEmail}
            placeholder={user.email}
            onChange={(event) => setConfirmEmail(event.target.value)}
          />
          <Button
            size="md"
            variant="ghost"
            className="text-rose-400"
            disabled={
              busy !== null ||
              user.isSelf ||
              user.onlyAdmin ||
              confirmEmail.trim().toLowerCase() !== user.email
            }
            onClick={() => void remove()}
          >
            {working("delete") ? <Spinner className="size-4" /> : <Trash2 className="size-4" />}
            Delete permanently
          </Button>
        </div>
        <p className="mt-2 text-[0.75rem] text-cloud-600">
          This cannot be undone, and the confirmation is checked again on the
          server.
        </p>
      </Panel>
    </div>
  );
}
