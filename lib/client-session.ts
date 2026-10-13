"use client";

import { useEffect, useSyncExternalStore } from "react";

/**
 * The navbar's view of who is signed in, on pages that are statically
 * rendered and so cannot ask the server during render (the homepage, Team).
 *
 * This is the one client-side session mechanism in the app. It reads
 * /api/auth/session — the same server-side session every guarded page
 * checks — once per page load, and again only when something announces a
 * change (login, signup, logout, a profile save). It is display state
 * only: nothing is ever authorised from it.
 */

export type Viewer = {
  name: string;
  email: string;
  avatarUrl: string | null;
  isAdmin: boolean;
};

/** undefined = not known yet; null = signed out. */
type State = Viewer | null | undefined;

let state: State = undefined;
let inflight: Promise<void> | null = null;
const listeners = new Set<() => void>();

function emit(next: State) {
  state = next;
  for (const listener of listeners) listener();
}

function load(): Promise<void> {
  if (inflight) return inflight;
  inflight = fetch("/api/auth/session", { cache: "no-store", credentials: "same-origin" })
    .then((res) => (res.ok ? res.json() : null))
    .then((data: { user?: Viewer | null } | null) => emit(data?.user ?? null))
    // A network failure is not a logout: keep whatever we last knew.
    .catch(() => {
      if (state === undefined) emit(null);
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * `known` is what a server-rendered page already resolved (Pricing passes
 * it); when present it wins and no request is made.
 */
export function useViewer(known?: Viewer | null): State {
  const current = useSyncExternalStore(
    subscribe,
    () => state,
    () => undefined,
  );

  useEffect(() => {
    if (known !== undefined) {
      // The server just checked: its answer replaces anything cached.
      if (JSON.stringify(state) !== JSON.stringify(known)) emit(known);
      return;
    }
    if (state === undefined) void load();
  }, [known]);

  if (known !== undefined && current === undefined) return known;
  return current;
}

/** Call after anything that changes who is signed in or how they look. */
export function sessionChanged(): void {
  state = undefined;
  void load();
}

/** Revokes the server session, then updates every mounted navbar. */
export async function logout(): Promise<boolean> {
  try {
    const res = await fetch("/api/auth/logout", { method: "POST" });
    if (!res.ok) return false;
    emit(null);
    return true;
  } catch {
    return false;
  }
}
