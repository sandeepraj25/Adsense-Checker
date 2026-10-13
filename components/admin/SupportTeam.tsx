"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Pencil, Plus, Trash2 } from "lucide-react";

import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";
import { useToast } from "@/components/ui/Toast";
import { cn } from "@/lib/cn";

export type RosterMember = {
  id: string;
  displayName: string;
  initials: string;
  role: "admin" | "member";
  userId: string | null;
  linkedLabel: string | null;
  chatEnabled: boolean;
  availability: "available" | "away";
  active: boolean;
  online: boolean;
  replies: number;
  isMe: boolean;
};

export type AdminAccount = { id: string; name: string; email: string; linkedAgentId: string | null };

async function call(url: string, method: string, body?: unknown): Promise<{ ok: boolean; message?: string }> {
  try {
    const res = await fetch(url, {
      method,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = (await res.json().catch(() => null)) as { ok: boolean; message?: string } | null;
    return data ?? { ok: false, message: "Unexpected answer from the server." };
  } catch {
    return { ok: false, message: "Couldn't reach the server." };
  }
}

/**
 * The support roster. Every change goes through /api/admin/support-team,
 * which re-checks the administrator and validates each field; this form
 * only collects them.
 */
export function SupportTeam({ members, accounts }: { members: RosterMember[]; accounts: AdminAccount[] }) {
  const router = useRouter();
  const { success, error } = useToast();
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);

  async function act(url: string, method: string, body: unknown, done: string) {
    const result = await call(url, method, body);
    if (!result.ok) {
      error("Not saved", result.message ?? "Nothing was changed.");
      return false;
    }
    success(done);
    router.refresh();
    return true;
  }

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        {!adding ? (
          <Button size="sm" onClick={() => setAdding(true)}>
            <Plus className="size-4" aria-hidden />
            Add member
          </Button>
        ) : null}
      </div>

      {adding ? (
        <MemberForm
          title="Add a support member"
          accounts={accounts}
          onCancel={() => setAdding(false)}
          onSave={async (values) => {
            if (await act("/api/admin/support-team", "POST", values, `${values.displayName} added`)) setAdding(false);
          }}
        />
      ) : null}

      <ul className="divide-y divide-ink-700 overflow-hidden rounded-xl border border-ink-700 bg-white">
        {members.length === 0 ? <li className="px-5 py-10 text-center text-[0.875rem] text-cloud-400">No support members yet.</li> : null}
        {members.map((member) => (
          <li key={member.id} className={cn("px-5 py-4", !member.active && "bg-ink-900")}>
            <div className="flex flex-wrap items-center gap-4">
              <span className="relative">
                <span className={cn("grid size-10 place-items-center rounded-full text-[0.8125rem] font-semibold", member.active ? "bg-azure-500/10 text-azure-600" : "bg-ink-850 text-cloud-400")}>
                  {member.initials}
                </span>
                <span
                  aria-hidden
                  className={cn("absolute -right-0.5 -bottom-0.5 size-3 rounded-full border-2 border-white", member.online ? "bg-mint-400" : "bg-zinc-300")}
                />
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-[0.9375rem] font-semibold text-cloud-50">
                  {member.displayName} {member.isMe ? <span className="font-normal text-cloud-400">(you)</span> : null}
                </p>
                <p className="mt-0.5 text-[0.8125rem] text-cloud-400">
                  {member.linkedLabel ? `Signs in as ${member.linkedLabel}` : "Not linked to an account — can't reply yet"}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                <Badge tone={member.role === "admin" ? "brand" : "neutral"}>{member.role === "admin" ? "Admin" : "Member"}</Badge>
                {!member.active ? (
                  <Badge tone="warn">Deactivated</Badge>
                ) : !member.chatEnabled ? (
                  <Badge>Off chat rota</Badge>
                ) : member.online ? (
                  <Badge tone="pass">Online</Badge>
                ) : (
                  <Badge>{member.availability === "away" ? "Away" : "Offline"}</Badge>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                <Button size="sm" variant="ghost" onClick={() => setEditing(editing === member.id ? null : member.id)} aria-label={`Edit ${member.displayName}`}>
                  <Pencil className="size-3.5" aria-hidden />
                  Edit
                </Button>
                {member.active ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => void act(`/api/admin/support-team/${member.id}`, "PATCH", { chatEnabled: !member.chatEnabled }, member.chatEnabled ? "Removed from chat support" : "Added to chat support")}
                  >
                    {member.chatEnabled ? "Remove from chat" : "Add to chat"}
                  </Button>
                ) : null}
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => void act(`/api/admin/support-team/${member.id}`, "PATCH", { active: !member.active }, member.active ? "Deactivated" : "Reactivated")}
                >
                  {member.active ? "Deactivate" : "Reactivate"}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={member.replies > 0}
                  title={member.replies > 0 ? `Has sent ${member.replies} replies — deactivate instead so those chats keep the name` : undefined}
                  aria-label={`Delete ${member.displayName}`}
                  onClick={() => {
                    if (window.confirm(`Delete ${member.displayName} from the support team? This can't be undone.`)) {
                      void act(`/api/admin/support-team/${member.id}`, "DELETE", undefined, "Member deleted");
                    }
                  }}
                >
                  <Trash2 className="size-3.5" aria-hidden />
                </Button>
              </div>
            </div>

            {editing === member.id ? (
              <div className="mt-4">
                <MemberForm
                  title={`Edit ${member.displayName}`}
                  initial={member}
                  accounts={accounts.filter((account) => !account.linkedAgentId || account.linkedAgentId === member.id)}
                  onCancel={() => setEditing(null)}
                  onSave={async (values) => {
                    if (await act(`/api/admin/support-team/${member.id}`, "PATCH", values, "Saved")) setEditing(null);
                  }}
                />
              </div>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

type FormValues = { displayName: string; role: "admin" | "member"; userId: string | null; availability: "available" | "away" };

function MemberForm({
  title,
  initial,
  accounts,
  onSave,
  onCancel,
}: {
  title: string;
  initial?: RosterMember;
  accounts: AdminAccount[];
  onSave: (values: FormValues) => Promise<void>;
  onCancel: () => void;
}) {
  const [displayName, setDisplayName] = useState(initial?.displayName ?? "");
  const [role, setRole] = useState<"admin" | "member">(initial?.role ?? "member");
  const [userId, setUserId] = useState(initial?.userId ?? "");
  const [availability, setAvailability] = useState<"available" | "away">(initial?.availability ?? "available");
  const [busy, setBusy] = useState(false);
  const [nameError, setNameError] = useState<string | undefined>();
  const available = accounts.filter((account) => !account.linkedAgentId || account.linkedAgentId === initial?.id);

  return (
    <form
      noValidate
      className="rounded-xl border border-ink-700 bg-ink-900 p-4"
      onSubmit={async (event) => {
        event.preventDefault();
        if (!displayName.trim()) {
          setNameError("Give the member a display name.");
          return;
        }
        setBusy(true);
        await onSave({ displayName, role, userId: userId || null, availability });
        setBusy(false);
      }}
    >
      <p className="text-[0.9375rem] font-semibold text-cloud-50">{title}</p>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <Field label="Display name" value={displayName} maxLength={40} error={nameError} hint="What customers see on replies." onChange={(e) => { setDisplayName(e.target.value); setNameError(undefined); }} />
        <SelectField label="Role shown in chat" value={role} onChange={(v) => setRole(v as "admin" | "member")} options={[{ value: "admin", label: "Admin" }, { value: "member", label: "Member" }]} hint="A label for customers; it doesn't change permissions." />
        <SelectField
          label="Linked login"
          value={userId}
          onChange={setUserId}
          options={[{ value: "", label: "Not linked" }, ...available.map((account) => ({ value: account.id, label: `${account.name} · ${account.email}` }))]}
          hint="An administrator account. Only a linked member can reply from the inbox."
        />
        <SelectField label="Availability" value={availability} onChange={(v) => setAvailability(v as "available" | "away")} options={[{ value: "available", label: "Available" }, { value: "away", label: "Away" }]} hint="Away shows as offline in the website chat." />
      </div>
      <div className="mt-4 flex gap-2">
        <Button type="submit" size="sm" disabled={busy} aria-busy={busy}>Save</Button>
        <Button type="button" size="sm" variant="ghost" onClick={onCancel}>Cancel</Button>
      </div>
    </form>
  );
}

function SelectField({
  label,
  value,
  onChange,
  options,
  hint,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: string }[];
  hint?: string;
}) {
  const id = `sel-${label.replace(/\W+/g, "-").toLowerCase()}`;
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-[0.875rem] font-medium text-cloud-50">{label}</label>
      <select id={id} value={value} onChange={(e) => onChange(e.target.value)} className="h-11 rounded-lg border border-ink-700 bg-white px-3 text-[0.9375rem] text-cloud-50 outline-none focus:border-azure-500 focus:ring-3 focus:ring-azure-500/15">
        {options.map((option) => (
          <option key={option.value} value={option.value}>{option.label}</option>
        ))}
      </select>
      {hint ? <p className="text-[0.8125rem] text-cloud-400">{hint}</p> : null}
    </div>
  );
}
