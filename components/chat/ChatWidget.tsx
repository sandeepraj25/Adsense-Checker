"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { MessageCircle, Send, X } from "lucide-react";

import { cn } from "@/lib/cn";

type Message = {
  id: string;
  from: "customer" | "agent";
  body: string;
  createdAt: number;
  agent: { name: string; role: string } | null;
  seen: boolean;
  clientId: string | null;
};

type Pending = { clientId: string; body: string; state: "sending" | "failed"; error?: string };

type State = {
  support: { online: boolean; team: { name: string; role: string; initials: string; online: boolean }[] };
  thread: {
    exists: boolean;
    status: "open" | "resolved" | null;
    messages: Message[];
    unread: number;
    guest: { name: string | null; email: string | null } | null;
  };
  viewer: { name: string | null; signedIn: boolean };
};

const MAX = 2000;

/** Pages where a floating button would get in the way of the task. */
function hiddenOn(path: string): boolean {
  return (
    path.startsWith("/admin") ||
    path.startsWith("/checkout") ||
    /^\/dashboard\/billing\/invoices\//.test(path) ||
    path === "/verify-email"
  );
}

function newClientId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

function timeLabel(ms: number): string {
  return new Intl.DateTimeFormat("en-IN", { hour: "numeric", minute: "2-digit" }).format(ms);
}

function dayLabel(ms: number): string {
  const day = new Date(ms);
  const today = new Date();
  const yesterday = new Date(Date.now() - 86_400_000);
  if (day.toDateString() === today.toDateString()) return "Today";
  if (day.toDateString() === yesterday.toDateString()) return "Yesterday";
  return new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric" }).format(ms);
}

/**
 * The floating support chat.
 *
 * Messages are saved on the server and arrive live over a Server-Sent
 * Events stream; the widget re-reads its thread through /api/chat after
 * each event, so it only ever renders what the server says it may see.
 * Nothing about who owns the conversation lives in the browser beyond the
 * httpOnly cookie the server sets.
 */
export function ChatWidget() {
  const pathname = usePathname() ?? "/";
  const hidden = hiddenOn(pathname);

  const [open, setOpen] = useState(false);
  const [state, setState] = useState<State | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [connection, setConnection] = useState<"connecting" | "live" | "reconnecting">("connecting");
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState<Pending[]>([]);
  const [askContact, setAskContact] = useState(false);

  const openRef = useRef(open);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const sourceRef = useRef<EventSource | null>(null);
  const panelId = useId();
  openRef.current = open;

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/chat${openRef.current ? "?read=1" : ""}`, { cache: "no-store" });
      const data = (await res.json()) as ({ ok: true } & State) | { ok: false };
      if (!data.ok) throw new Error("not ok");
      setState({ support: data.support, thread: data.thread, viewer: data.viewer });
      setLoadError(false);
      // Anything the server now has is no longer pending.
      setPending((list) => list.filter((p) => !data.thread.messages.some((m) => m.clientId === p.clientId)));
    } catch {
      setLoadError(true);
    }
  }, []);

  const connect = useCallback(() => {
    sourceRef.current?.close();
    const source = new EventSource("/api/chat/stream");
    sourceRef.current = source;
    source.addEventListener("ready", () => {
      setConnection("live");
      void load(); // catch up on anything missed while disconnected
    });
    source.addEventListener("chat", () => void load());
    source.onerror = () => setConnection("reconnecting");
  }, [load]);

  // Load, connect, and keep a slow safety poll for presence changes.
  useEffect(() => {
    if (hidden) return;
    void load();
    connect();
    const poll = window.setInterval(() => void load(), 45_000);
    return () => {
      window.clearInterval(poll);
      sourceRef.current?.close();
      sourceRef.current = null;
    };
  }, [hidden, load, connect]);

  // Other parts of the app (the dashboard's "Support chat") can open it.
  useEffect(() => {
    const show = () => setOpen(true);
    window.addEventListener("aec:open-chat", show);
    return () => window.removeEventListener("aec:open-chat", show);
  }, []);

  // Opening marks replies read and puts focus in the composer.
  useEffect(() => {
    if (!open) return;
    void load();
    const t = window.setTimeout(() => inputRef.current?.focus(), 50);
    return () => window.clearTimeout(t);
  }, [open, load]);

  // Keep the newest message in view.
  const count = (state?.thread.messages.length ?? 0) + pending.length;
  useEffect(() => {
    if (!open) return;
    const list = listRef.current;
    if (list) list.scrollTop = list.scrollHeight;
  }, [open, count]);

  // Escape closes; focus returns to the button.
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        buttonRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  async function deliver(item: Pending) {
    const hadThread = state?.thread.exists ?? false;
    setPending((list) => [...list.filter((p) => p.clientId !== item.clientId), { ...item, state: "sending" }]);
    try {
      const res = await fetch("/api/chat/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body: item.body, clientId: item.clientId }),
      });
      const data = (await res.json().catch(() => null)) as { ok: boolean; message?: string } | null;
      if (!res.ok || !data?.ok) {
        setPending((list) =>
          list.map((p) =>
            p.clientId === item.clientId
              ? { ...p, state: "failed", error: data?.message ?? "Not sent. Check your connection and try again." }
              : p,
          ),
        );
        return;
      }
      await load();
      if (!hadThread) {
        // The first message created the conversation; reconnect so the
        // stream is bound to it.
        connect();
        if (!state?.viewer.signedIn) setAskContact(true);
      }
    } catch {
      setPending((list) =>
        list.map((p) =>
          p.clientId === item.clientId ? { ...p, state: "failed", error: "Not sent. Check your connection and try again." } : p,
        ),
      );
    }
  }

  function submit() {
    const body = draft.trim();
    if (!body || body.length > MAX) return;
    // One click, one message: the draft clears immediately and the
    // clientId makes any retry of the same message idempotent.
    setDraft("");
    void deliver({ clientId: newClientId(), body, state: "sending" });
  }

  if (hidden) return null;

  const online = state?.support.online ?? false;
  const unread = open ? 0 : state?.thread.unread ?? 0;
  const messages = state?.thread.messages ?? [];
  const onlineTeam = state?.support.team.filter((m) => m.online) ?? [];
  let lastDay = "";

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={
          open ? "Close support chat" : `Open support chat${unread ? ` — ${unread} unread ${unread === 1 ? "reply" : "replies"}` : ""}`
        }
        className={cn(
          "no-print fixed right-4 bottom-4 z-40 grid size-14 place-items-center rounded-full bg-azure-500 text-white sm:right-6 sm:bottom-6",
          "shadow-[0_8px_24px_-8px_rgba(79,70,229,0.6)] transition-colors hover:bg-azure-600",
          "focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-azure-500",
          open && "max-sm:hidden",
        )}
      >
        {open ? <X className="size-6" aria-hidden /> : <MessageCircle className="size-6" aria-hidden />}
        {unread > 0 ? (
          <span
            aria-hidden
            className="absolute -top-1 -right-1 grid min-w-5 place-items-center rounded-full border-2 border-white bg-rose-500 px-1 text-[0.6875rem] font-semibold leading-4 text-white"
          >
            {unread > 9 ? "9+" : unread}
          </span>
        ) : null}
      </button>

      {open ? (
        <section
          id={panelId}
          role="dialog"
          aria-label="Support chat"
          className={cn(
            "no-print fixed z-50 flex flex-col overflow-hidden border border-ink-700 bg-white",
            "inset-x-0 bottom-0 h-[85dvh] rounded-t-xl",
            "sm:inset-x-auto sm:right-6 sm:bottom-24 sm:h-[34rem] sm:max-h-[calc(100dvh-8rem)] sm:w-[23rem] sm:rounded-xl",
            "shadow-[0_24px_48px_-16px_rgba(24,24,27,0.25)]",
          )}
        >
          {/* Header */}
          <header className="flex items-start gap-3 border-b border-ink-700 px-4 py-3.5">
            <div className="min-w-0 flex-1">
              <h2 className="text-[1rem] font-semibold text-cloud-50">AdSense Checker Support</h2>
              <p className="mt-0.5 flex items-center gap-1.5 text-[0.8125rem] text-cloud-300">
                <span
                  aria-hidden
                  className={cn("size-2 shrink-0 rounded-full", online ? "bg-mint-400" : "bg-zinc-300")}
                />
                {state === null
                  ? "Checking who's around…"
                  : online
                    ? `Online — ${onlineTeam.map((m) => m.name).join(", ")} ${onlineTeam.length === 1 ? "is" : "are"} here now`
                    : "Offline — leave a message and we'll reply when we're back"}
              </p>
            </div>
            {onlineTeam.length > 0 ? (
              <div className="flex -space-x-1.5" aria-hidden>
                {onlineTeam.slice(0, 3).map((member) => (
                  <span
                    key={member.name}
                    title={`${member.name} · ${member.role}`}
                    className="grid size-7 place-items-center rounded-full border-2 border-white bg-azure-500/10 text-[0.6875rem] font-semibold text-azure-600"
                  >
                    {member.initials}
                  </span>
                ))}
              </div>
            ) : null}
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                buttonRef.current?.focus();
              }}
              aria-label="Close support chat"
              className="-mt-0.5 -mr-1 grid size-8 place-items-center rounded-md text-cloud-400 hover:bg-ink-900 hover:text-cloud-50 focus-visible:outline-2 focus-visible:outline-azure-500"
            >
              <X className="size-4" aria-hidden />
            </button>
          </header>

          {connection === "reconnecting" ? (
            <p role="status" className="border-b border-amber-400/30 bg-amber-400/[0.08] px-4 py-1.5 text-[0.8125rem] text-cloud-200">
              Reconnecting… messages you send are still saved.
            </p>
          ) : null}

          {/* Messages */}
          <div ref={listRef} className="flex-1 space-y-3 overflow-y-auto bg-ink-900 px-4 py-4" aria-live="polite">
            <div className="max-w-[85%] rounded-xl rounded-tl-sm border border-ink-700 bg-white px-3.5 py-2.5 text-[0.9375rem] leading-relaxed text-cloud-200">
              Hi{state?.viewer.name ? ` ${state.viewer.name.split(" ")[0]}` : ""}! Ask us anything about your site, a report, or your
              plan{online ? "." : " — we'll see it when we're back online."}
            </div>

            {loadError && !state ? (
              <p role="alert" className="text-[0.875rem] text-rose-400">
                We couldn&apos;t load your chat. Check your connection — it will retry automatically.
              </p>
            ) : null}

            {messages.map((message, index) => {
              const day = dayLabel(message.createdAt);
              const showDay = day !== lastDay;
              lastDay = day;
              const mine = message.from === "customer";
              const lastMine = mine && !messages.slice(index + 1).some((m) => m.from === "customer");
              return (
                <div key={message.id}>
                  {showDay ? (
                    <p className="my-2 text-center text-[0.75rem] font-medium text-cloud-400">{day}</p>
                  ) : null}
                  <div className={cn("flex flex-col", mine ? "items-end" : "items-start")}>
                    {!mine && message.agent ? (
                      <p className="mb-1 text-[0.75rem] font-medium text-cloud-300">
                        {message.agent.name} · {message.agent.role}
                      </p>
                    ) : null}
                    <div
                      className={cn(
                        "max-w-[85%] whitespace-pre-wrap break-words px-3.5 py-2.5 text-[0.9375rem] leading-relaxed",
                        mine
                          ? "rounded-xl rounded-br-sm bg-azure-500 text-white"
                          : "rounded-xl rounded-tl-sm border border-ink-700 bg-white text-cloud-50",
                      )}
                    >
                      {message.body}
                    </div>
                    <p className="mt-1 text-[0.75rem] text-cloud-400">
                      <time dateTime={new Date(message.createdAt).toISOString()}>{timeLabel(message.createdAt)}</time>
                      {lastMine ? (message.seen ? " · Seen" : " · Sent") : ""}
                    </p>
                  </div>
                </div>
              );
            })}

            {pending.map((item) => (
              <div key={item.clientId} className="flex flex-col items-end">
                <div
                  className={cn(
                    "max-w-[85%] whitespace-pre-wrap break-words rounded-xl rounded-br-sm px-3.5 py-2.5 text-[0.9375rem] leading-relaxed",
                    item.state === "failed" ? "border border-rose-400/40 bg-rose-400/[0.06] text-cloud-50" : "bg-azure-500/70 text-white",
                  )}
                >
                  {item.body}
                </div>
                {item.state === "sending" ? (
                  <p className="mt-1 text-[0.75rem] text-cloud-400" role="status">
                    Sending…
                  </p>
                ) : (
                  <p className="mt-1 text-right text-[0.75rem] text-rose-400" role="alert">
                    {item.error}{" "}
                    <button type="button" className="font-semibold underline" onClick={() => void deliver(item)}>
                      Retry
                    </button>
                  </p>
                )}
              </div>
            ))}

            {state?.thread.status === "resolved" ? (
              <p className="text-center text-[0.8125rem] text-cloud-400">
                This conversation was marked resolved. Write again any time — it reopens.
              </p>
            ) : null}

            {askContact && state && !state.viewer.signedIn && !state.thread.guest?.email ? (
              <GuestContact onDone={() => { setAskContact(false); void load(); }} />
            ) : null}
          </div>

          {/* Composer */}
          <form
            className="border-t border-ink-700 bg-white p-3"
            onSubmit={(event) => {
              event.preventDefault();
              submit();
            }}
          >
            <div className="flex items-end gap-2">
              <label htmlFor={`${panelId}-input`} className="sr-only">
                Your message
              </label>
              <textarea
                ref={inputRef}
                id={`${panelId}-input`}
                rows={1}
                value={draft}
                maxLength={MAX + 200}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                    event.preventDefault();
                    submit();
                  }
                }}
                placeholder={online ? "Write a message…" : "Leave us a message…"}
                className="max-h-32 min-h-11 flex-1 resize-none rounded-lg border border-ink-700 bg-white px-3 py-2.5 text-[0.9375rem] text-cloud-50 outline-none placeholder:text-cloud-400 focus:border-azure-500 focus:ring-3 focus:ring-azure-500/15"
              />
              <button
                type="submit"
                disabled={!draft.trim() || draft.trim().length > MAX}
                aria-label="Send message"
                className="grid size-11 shrink-0 place-items-center rounded-lg bg-azure-500 text-white transition-colors hover:bg-azure-600 disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-azure-500"
              >
                <Send className="size-4" aria-hidden />
              </button>
            </div>
            <p className="mt-1.5 flex justify-between text-[0.75rem] text-cloud-400">
              <span>Enter to send · Shift+Enter for a new line</span>
              {draft.length > MAX - 200 ? (
                <span className={draft.trim().length > MAX ? "text-rose-400" : ""}>
                  {draft.trim().length}/{MAX}
                </span>
              ) : null}
            </p>
          </form>
        </section>
      ) : null}
    </>
  );
}

function GuestContact({ onDone }: { onDone: () => void }) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const id = useId();

  return (
    <form
      className="rounded-xl border border-ink-700 bg-white p-3"
      onSubmit={async (event) => {
        event.preventDefault();
        if (busy) return;
        setBusy(true);
        setError(null);
        try {
          const res = await fetch("/api/chat/contact", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name, email }),
          });
          const data = (await res.json().catch(() => null)) as { ok: boolean; message?: string } | null;
          if (!data?.ok) setError(data?.message ?? "Couldn't save that. Try again.");
          else onDone();
        } catch {
          setError("Couldn't save that. Try again.");
        } finally {
          setBusy(false);
        }
      }}
    >
      <p className="text-[0.875rem] font-medium text-cloud-50">Want a reply by email too?</p>
      <p className="mt-0.5 text-[0.8125rem] text-cloud-400">Optional — so we can follow up if you leave.</p>
      <div className="mt-2 grid gap-2">
        <label htmlFor={`${id}-n`} className="sr-only">Your name</label>
        <input id={`${id}-n`} value={name} onChange={(e) => setName(e.target.value)} placeholder="Your name" autoComplete="name"
          className="h-10 rounded-lg border border-ink-700 px-3 text-[0.875rem] outline-none focus:border-azure-500" />
        <label htmlFor={`${id}-e`} className="sr-only">Your email</label>
        <input id={`${id}-e`} type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" autoComplete="email"
          className="h-10 rounded-lg border border-ink-700 px-3 text-[0.875rem] outline-none focus:border-azure-500" />
      </div>
      {error ? <p role="alert" className="mt-2 text-[0.8125rem] text-rose-400">{error}</p> : null}
      <div className="mt-2 flex gap-2">
        <button type="submit" disabled={busy} className="h-9 rounded-lg bg-azure-500 px-3 text-[0.875rem] font-medium text-white hover:bg-azure-600 disabled:opacity-60">
          Save
        </button>
        <button type="button" onClick={onDone} className="h-9 rounded-lg px-3 text-[0.875rem] font-medium text-cloud-300 hover:bg-ink-900">
          No thanks
        </button>
      </div>
    </form>
  );
}
