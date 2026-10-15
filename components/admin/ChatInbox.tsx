"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, CheckCircle2, Info, RotateCcw, Search, Send } from "lucide-react";

import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/cn";

type Filter = "all" | "unread" | "open" | "mine" | "resolved";

type Item = {
  id: string;
  customerName: string;
  customerEmail: string | null;
  isGuest: boolean;
  preview: string;
  lastSender: "customer" | "agent" | null;
  lastMessageAt: number;
  unread: number;
  status: "open" | "resolved";
  assignedAgent: { id: string; name: string } | null;
  customerOnline: boolean;
  priority?: boolean;
};

type Message = {
  id: string;
  from: "customer" | "agent";
  body: string;
  createdAt: number;
  agent: { name: string; role: string } | null;
  seen: boolean;
  clientId: string | null;
};

type Detail = {
  item: Item;
  createdAt: number;
  account: { id: string; name: string; email: string; status: string; createdAt: number; plan: string | null } | null;
  messages: Message[];
};

type Me = { id: string; name: string; role: string; availability: "available" | "away"; online: boolean } | null;
type TeamMember = { id: string; name: string; role: string };

const FILTERS: { key: Filter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "unread", label: "Unread" },
  { key: "open", label: "Open" },
  { key: "mine", label: "Assigned to me" },
  { key: "resolved", label: "Resolved" },
];

function when(ms: number): string {
  const d = new Date(ms);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
    return new Intl.DateTimeFormat("en-IN", { hour: "numeric", minute: "2-digit" }).format(ms);
  }
  return new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short" }).format(ms);
}

function stamp(ms: number): string {
  return new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }).format(ms);
}

function initialsOf(name: string): string {
  const parts = name.replace(/\(guest\)/, "").replace(/[^\p{L}\p{N}\s]/gu, "").trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "") + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase() || "?";
}

function newClientId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

export function ChatInbox({
  initial,
  team,
}: {
  initial: { items: Item[]; counts: Record<Filter, number>; me: Me; replyBlocker: string | null };
  team: TeamMember[];
}) {
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [items, setItems] = useState(initial.items);
  const [counts, setCounts] = useState(initial.counts);
  const [me, setMe] = useState<Me>(initial.me);
  const [blocker, setBlocker] = useState(initial.replyBlocker);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [mobileView, setMobileView] = useState<"list" | "thread" | "details">("list");
  const [connection, setConnection] = useState<"connecting" | "live" | "reconnecting">("connecting");
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectedRef = useRef<string | null>(null);
  const filterRef = useRef(filter);
  const queryRef = useRef(query);
  const listEnd = useRef<HTMLDivElement>(null);
  selectedRef.current = selected;
  filterRef.current = filter;
  queryRef.current = query;

  const loadList = useCallback(async () => {
    const params = new URLSearchParams({ filter: filterRef.current });
    if (queryRef.current.trim()) params.set("q", queryRef.current.trim());
    try {
      const res = await fetch(`/api/admin/chats?${params}`, { cache: "no-store" });
      const data = await res.json();
      if (data.ok) {
        setItems(data.items);
        setCounts(data.counts);
        setMe(data.me);
        setBlocker(data.replyBlocker);
      }
    } catch {
      /* the stream reconnects and reloads */
    }
  }, []);

  const loadDetail = useCallback(async (id: string) => {
    try {
      const res = await fetch(`/api/admin/chats/${id}`, { cache: "no-store" });
      const data = await res.json();
      if (data.ok && selectedRef.current === id) setDetail(data.detail);
    } catch {
      /* retried on the next event */
    }
  }, []);

  // Live updates.
  useEffect(() => {
    const source = new EventSource("/api/admin/chats/stream");
    source.addEventListener("ready", () => {
      setConnection("live");
      void loadList();
      if (selectedRef.current) void loadDetail(selectedRef.current);
    });
    source.addEventListener("chat", (event) => {
      const data = JSON.parse((event as MessageEvent).data) as { type: string; conversationId?: string };
      void loadList();
      if (data.conversationId && data.conversationId === selectedRef.current) void loadDetail(data.conversationId);
    });
    source.onerror = () => setConnection("reconnecting");
    const poll = window.setInterval(() => void loadList(), 60_000);
    return () => {
      source.close();
      window.clearInterval(poll);
    };
  }, [loadList, loadDetail]);

  useEffect(() => {
    void loadList();
  }, [filter, loadList]);

  useEffect(() => {
    const t = window.setTimeout(() => void loadList(), 250);
    return () => window.clearTimeout(t);
  }, [query, loadList]);

  useEffect(() => {
    listEnd.current?.scrollIntoView({ block: "end" });
  }, [detail?.messages.length, selected]);

  function open(id: string) {
    setSelected(id);
    setDetail(null);
    setError(null);
    setMobileView("thread");
    void loadDetail(id);
  }

  async function reply() {
    const body = draft.trim();
    if (!body || !selected || sending) return;
    setSending(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/chats/${selected}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body, clientId: newClientId() }),
      });
      const data = await res.json();
      if (!data.ok) setError(data.message ?? "Not sent.");
      else {
        setDraft("");
        await loadDetail(selected);
        void loadList();
      }
    } catch {
      setError("Not sent. Check your connection and try again.");
    } finally {
      setSending(false);
    }
  }

  async function patch(body: Record<string, unknown>) {
    if (!selected) return;
    setError(null);
    const res = await fetch(`/api/admin/chats/${selected}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => null);
    if (!data?.ok) setError(data?.message ?? "Couldn't update the conversation.");
    else {
      setDetail(data.detail);
      void loadList();
    }
  }

  async function setAvailability(next: "available" | "away") {
    if (!me) return;
    const res = await fetch(`/api/admin/support-team/${me.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ availability: next }),
    });
    if (res.ok) void loadList();
  }

  const current = detail?.item ?? items.find((item) => item.id === selected) ?? null;
  const assignable = useMemo(() => team, [team]);

  return (
    <div className="space-y-4">
      {/* Who am I in chat */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-ink-700 bg-white px-4 py-3">
        {me ? (
          <p className="flex items-center gap-2 text-[0.9375rem] text-cloud-200">
            <span aria-hidden className={cn("size-2.5 rounded-full", me.online ? "bg-mint-400" : "bg-zinc-300")} />
            You reply as <span className="font-semibold text-cloud-50">{me.name}</span> ({me.role === "admin" ? "Admin" : "Member"}) ·{" "}
            {me.availability === "away" ? "Away — customers see you as offline" : me.online ? "Online to customers" : "Connecting…"}
          </p>
        ) : (
          <p className="text-[0.9375rem] text-cloud-200">{blocker}</p>
        )}
        <div className="flex items-center gap-2">
          {me ? (
            <div role="group" aria-label="Your availability" className="inline-flex rounded-lg border border-ink-700 p-0.5">
              {(["available", "away"] as const).map((value) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={me.availability === value}
                  onClick={() => void setAvailability(value)}
                  className={cn(
                    "rounded-md px-3 py-1 text-[0.8125rem] font-medium",
                    me.availability === value ? "bg-azure-500 text-white" : "text-cloud-300 hover:bg-ink-900",
                  )}
                >
                  {value === "available" ? "Available" : "Away"}
                </button>
              ))}
            </div>
          ) : (
            <Link href="/admin/support-team" className="text-[0.875rem] font-medium text-azure-600 hover:underline">
              Open Support team
            </Link>
          )}
          <span className="text-[0.8125rem] text-cloud-400" role="status">
            {connection === "live" ? "Live" : connection === "reconnecting" ? "Reconnecting…" : "Connecting…"}
          </span>
        </div>
      </div>

      <div className="grid min-h-[36rem] overflow-hidden rounded-xl border border-ink-700 bg-white lg:h-[calc(100dvh-16rem)] lg:grid-cols-[20rem_minmax(0,1fr)] xl:grid-cols-[20rem_minmax(0,1fr)_17rem]">
        {/* ── conversations ── */}
        <aside className={cn("flex min-h-0 flex-col border-ink-700 lg:border-r", mobileView !== "list" && "max-lg:hidden")} aria-label="Conversations">
          <div className="space-y-3 border-b border-ink-700 p-3">
            <label className="relative block">
              <span className="sr-only">Search conversations</span>
              <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-cloud-400" aria-hidden />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search name, email or message"
                className="h-9 w-full rounded-lg border border-ink-700 pr-3 pl-9 text-[0.875rem] outline-none focus:border-azure-500 focus:ring-3 focus:ring-azure-500/15"
              />
            </label>
            <div className="flex flex-wrap gap-1.5" role="tablist" aria-label="Filter conversations">
              {FILTERS.map((entry) => (
                <button
                  key={entry.key}
                  type="button"
                  role="tab"
                  aria-selected={filter === entry.key}
                  onClick={() => setFilter(entry.key)}
                  className={cn(
                    "inline-flex h-7 items-center gap-1 rounded-md border px-2 text-[0.8125rem] font-medium",
                    filter === entry.key ? "border-azure-500/30 bg-azure-500/[0.07] text-azure-600" : "border-ink-700 text-cloud-300 hover:bg-ink-900",
                  )}
                >
                  {entry.label}
                  <span className="text-cloud-400">{counts[entry.key]}</span>
                </button>
              ))}
            </div>
          </div>
          <ul className="min-h-0 flex-1 divide-y divide-ink-700 overflow-y-auto">
            {items.length === 0 ? (
              <li className="px-4 py-10 text-center text-[0.875rem] text-cloud-400">
                {filter === "all" && !query ? "No conversations yet. Messages from the website chat appear here." : "Nothing matches."}
              </li>
            ) : (
              items.map((item) => (
                <li key={item.id}>
                  <button
                    type="button"
                    onClick={() => open(item.id)}
                    aria-current={selected === item.id ? "true" : undefined}
                    className={cn(
                      "flex w-full gap-3 px-3 py-3 text-left transition-colors hover:bg-ink-900",
                      selected === item.id && "bg-azure-500/[0.06]",
                    )}
                  >
                    <span className="relative shrink-0">
                      <span className="grid size-9 place-items-center rounded-full bg-ink-850 text-[0.75rem] font-semibold text-cloud-200">
                        {initialsOf(item.customerName)}
                      </span>
                      <span
                        aria-label={item.customerOnline ? "Online" : "Offline"}
                        className={cn("absolute -right-0.5 -bottom-0.5 size-3 rounded-full border-2 border-white", item.customerOnline ? "bg-mint-400" : "bg-zinc-300")}
                      />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-baseline justify-between gap-2">
                        <span className={cn("truncate text-[0.9375rem]", item.unread ? "font-semibold text-cloud-50" : "font-medium text-cloud-100")}>
                          {item.customerName}
                        </span>
                        <span className="shrink-0 text-[0.75rem] text-cloud-400">{when(item.lastMessageAt)}</span>
                      </span>
                      <span className="mt-0.5 flex items-center gap-2">
                        <span className={cn("truncate text-[0.8125rem]", item.unread ? "text-cloud-200" : "text-cloud-400")}>
                          {item.lastSender === "agent" ? "Support: " : ""}
                          {item.preview || "—"}
                        </span>
                        {item.unread ? (
                          <span className="ml-auto grid min-w-5 shrink-0 place-items-center rounded-full bg-azure-500 px-1.5 text-[0.6875rem] font-semibold leading-5 text-white">
                            {item.unread}
                            <span className="sr-only"> unread</span>
                          </span>
                        ) : null}
                      </span>
                      <span className="mt-1 flex flex-wrap gap-1.5">
                        <Badge tone={item.status === "open" ? "brand" : "neutral"}>{item.status === "open" ? "Open" : "Resolved"}</Badge>
                        {item.priority ? <Badge tone="warn">Priority</Badge> : null}
                        {item.isGuest ? <Badge>Guest</Badge> : null}
                        {item.assignedAgent ? <Badge>{item.assignedAgent.name}</Badge> : null}
                      </span>
                    </span>
                  </button>
                </li>
              ))
            )}
          </ul>
        </aside>

        {/* ── conversation ── */}
        <section className={cn("flex min-h-0 flex-col", mobileView === "list" && "max-lg:hidden", mobileView === "details" && "max-xl:hidden")} aria-label="Conversation">
          {!current ? (
            <div className="grid flex-1 place-items-center p-8 text-center text-[0.9375rem] text-cloud-400">Choose a conversation to read and reply.</div>
          ) : (
            <>
              <header className="flex flex-wrap items-center gap-2 border-b border-ink-700 px-4 py-3">
                <button type="button" onClick={() => setMobileView("list")} className="-ml-1 grid size-8 place-items-center rounded-md hover:bg-ink-900 lg:hidden" aria-label="Back to conversations">
                  <ArrowLeft className="size-4" aria-hidden />
                </button>
                <div className="min-w-[10rem] flex-1">
                  <h2 className="truncate text-[1rem] font-semibold text-cloud-50">{current.customerName}</h2>
                  <p className="text-[0.8125rem] text-cloud-400">
                    {current.customerOnline ? "Online now" : "Offline"} · {current.isGuest ? "Guest" : "Registered user"}
                  </p>
                </div>
                <label className="sr-only" htmlFor="assign">Assigned to</label>
                <select
                  id="assign"
                  value={current.assignedAgent?.id ?? ""}
                  onChange={(event) => void patch({ assignedAgentId: event.target.value || null })}
                  className="h-8 rounded-md border border-ink-700 bg-white px-2 text-[0.8125rem] text-cloud-200"
                >
                  <option value="">Unassigned</option>
                  {assignable.map((member) => (
                    <option key={member.id} value={member.id}>
                      {member.name} · {member.role}
                    </option>
                  ))}
                </select>
                {current.status === "open" ? (
                  <Button size="sm" variant="ghost" onClick={() => void patch({ status: "resolved" })}>
                    <CheckCircle2 className="size-3.5" aria-hidden />
                    Resolve
                  </Button>
                ) : (
                  <Button size="sm" variant="ghost" onClick={() => void patch({ status: "open" })}>
                    <RotateCcw className="size-3.5" aria-hidden />
                    Reopen
                  </Button>
                )}
                <button type="button" onClick={() => setMobileView("details")} className="grid size-8 place-items-center rounded-md hover:bg-ink-900 xl:hidden" aria-label="Conversation details">
                  <Info className="size-4" aria-hidden />
                </button>
              </header>

              <div className="min-h-0 flex-1 space-y-3 overflow-y-auto bg-ink-900 px-4 py-4" aria-live="polite">
                {!detail ? <p className="text-center text-[0.875rem] text-cloud-400">Loading…</p> : null}
                {detail?.messages.map((message, index) => {
                  const mine = message.from === "agent";
                  const lastAgent = mine && !detail.messages.slice(index + 1).some((m) => m.from === "agent");
                  return (
                    <div key={message.id} className={cn("flex flex-col", mine ? "items-end" : "items-start")}>
                      <p className="mb-1 text-[0.75rem] font-medium text-cloud-300">
                        {mine ? `${message.agent?.name ?? "Support"} · ${message.agent?.role ?? ""}` : current.customerName}
                      </p>
                      <div
                        className={cn(
                          "max-w-[80%] whitespace-pre-wrap break-words px-3.5 py-2.5 text-[0.9375rem] leading-relaxed",
                          mine ? "rounded-xl rounded-br-sm bg-azure-500 text-white" : "rounded-xl rounded-tl-sm border border-ink-700 bg-white text-cloud-50",
                        )}
                      >
                        {message.body}
                      </div>
                      <p className="mt-1 text-[0.75rem] text-cloud-400">
                        {stamp(message.createdAt)}
                        {lastAgent ? (message.seen ? " · Seen by customer" : " · Delivered") : ""}
                      </p>
                    </div>
                  );
                })}
                <div ref={listEnd} />
              </div>

              <form
                className="border-t border-ink-700 p-3"
                onSubmit={(event) => {
                  event.preventDefault();
                  void reply();
                }}
              >
                {error ? <p role="alert" className="mb-2 text-[0.875rem] text-rose-400">{error}</p> : null}
                {blocker ? (
                  <p className="rounded-lg border border-amber-400/30 bg-amber-400/[0.08] px-3 py-2 text-[0.875rem] text-cloud-200">
                    {blocker} <Link href="/admin/support-team" className="font-medium text-azure-600 hover:underline">Support team</Link>
                  </p>
                ) : (
                  <div className="flex items-end gap-2">
                    <label htmlFor="reply" className="sr-only">Reply</label>
                    <textarea
                      id="reply"
                      rows={2}
                      value={draft}
                      maxLength={2200}
                      onChange={(event) => setDraft(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                          event.preventDefault();
                          void reply();
                        }
                      }}
                      placeholder={`Reply as ${me?.name ?? "support"}…`}
                      className="max-h-40 min-h-11 flex-1 resize-none rounded-lg border border-ink-700 px-3 py-2.5 text-[0.9375rem] outline-none focus:border-azure-500 focus:ring-3 focus:ring-azure-500/15"
                    />
                    <Button type="submit" disabled={sending || !draft.trim()} aria-busy={sending}>
                      <Send className="size-4" aria-hidden />
                      {sending ? "Sending…" : "Send"}
                    </Button>
                  </div>
                )}
              </form>
            </>
          )}
        </section>

        {/* ── details ── */}
        <aside
          aria-label="Conversation details"
          className={cn(
            "min-h-0 overflow-y-auto border-ink-700 p-4 xl:border-l",
            mobileView !== "details" && "max-xl:hidden",
            !current && "max-xl:hidden",
          )}
        >
          {current ? (
            <>
              <button type="button" onClick={() => setMobileView("thread")} className="mb-3 inline-flex items-center gap-1.5 text-[0.875rem] font-medium text-azure-600 xl:hidden">
                <ArrowLeft className="size-4" aria-hidden /> Back to conversation
              </button>
              <h3 className="text-[0.9375rem] font-semibold text-cloud-50">Details</h3>
              <dl className="mt-3 space-y-3 text-[0.875rem]">
                <Row label="Customer">{current.customerName}</Row>
                <Row label="Email">{current.customerEmail ?? <span className="text-cloud-400">Not given</span>}</Row>
                <Row label="Type">{current.isGuest ? "Guest visitor" : "Registered user"}</Row>
                <Row label="Presence">{current.customerOnline ? "Online now" : "Offline"}</Row>
                <Row label="Assigned to">{current.assignedAgent?.name ?? "Unassigned"}</Row>
                <Row label="Status">{current.status === "open" ? "Open" : "Resolved"}</Row>
                {detail ? <Row label="Started">{stamp(detail.createdAt)}</Row> : null}
              </dl>
              {detail?.account ? (
                <div className="mt-5 border-t border-ink-700 pt-4">
                  <h3 className="text-[0.9375rem] font-semibold text-cloud-50">Account</h3>
                  <dl className="mt-3 space-y-3 text-[0.875rem]">
                    <Row label="Plan">{detail.account.plan ?? "No active plan"}</Row>
                    <Row label="Account status">{detail.account.status === "active" ? "Active" : "Suspended"}</Row>
                    <Row label="Joined">{stamp(detail.account.createdAt)}</Row>
                  </dl>
                  <Link href={`/admin/users/${detail.account.id}`} className="mt-3 inline-block text-[0.875rem] font-medium text-azure-600 hover:underline">
                    Open account
                  </Link>
                </div>
              ) : null}
            </>
          ) : null}
        </aside>
      </div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-[0.8125rem] text-cloud-400">{label}</dt>
      <dd className="mt-0.5 break-words text-cloud-50">{children}</dd>
    </div>
  );
}
