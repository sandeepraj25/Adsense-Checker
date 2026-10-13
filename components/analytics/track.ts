/**
 * The browser half of first-party analytics. Tiny on purpose: one POST
 * per page view, sent with `keepalive` after the page has rendered, no
 * third-party script, no cookie.
 *
 * Nothing is sent when the visitor's browser asks not to be tracked
 * (Do Not Track or Global Privacy Control), on admin pages, or in a
 * browser an administrator excluded from Settings. Only the pathname is
 * sent — never the query string — plus utm_* tags on the first page of a
 * visit and the referring page (which the server reduces to its host).
 */

export type ClientEventName = "page_view" | "pricing_viewed" | "plan_selected" | "checkout_started";

const VID_KEY = "aec_vid";
const CONSENT_KEY = "aec_consent";
const IGNORE_KEY = "aec_analytics_ignore";

type State = {
  disabled: boolean;
  consentMode: "ask" | "none" | null;
  firstSent: boolean;
};

const state: State = { disabled: false, consentMode: null, firstSent: false };
const listeners = new Set<(mode: "ask" | "none") => void>();

function storage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function read(key: string): string | null {
  try {
    return storage()?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function write(key: string, value: string | null): void {
  try {
    if (value === null) storage()?.removeItem(key);
    else storage()?.setItem(key, value);
  } catch {
    /* storage blocked: nothing is remembered, which is fine */
  }
}

export function optedOut(): boolean {
  if (typeof navigator === "undefined") return true;
  const nav = navigator as Navigator & { globalPrivacyControl?: boolean; msDoNotTrack?: string };
  if (nav.globalPrivacyControl === true) return true;
  if (nav.doNotTrack === "1" || nav.msDoNotTrack === "1") return true;
  return read(IGNORE_KEY) === "1";
}

function uuid(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function excludedPath(path: string): boolean {
  return path === "/admin" || path.startsWith("/admin/");
}

export function consentChoice(): "granted" | "denied" | null {
  const value = read(CONSENT_KEY);
  return value === "granted" || value === "denied" ? value : null;
}

export function setConsent(choice: "granted" | "denied" | null): void {
  if (choice === "granted") {
    write(CONSENT_KEY, "granted");
    if (!read(VID_KEY)) write(VID_KEY, uuid());
  } else {
    write(CONSENT_KEY, choice);
    write(VID_KEY, null);
  }
}

export function onConsentMode(fn: (mode: "ask" | "none") => void): () => void {
  listeners.add(fn);
  if (state.consentMode) fn(state.consentMode);
  return () => listeners.delete(fn);
}

export function currentConsentMode(): "ask" | "none" | null {
  return state.consentMode;
}

/** Excludes (or re-includes) this browser from analytics. */
export function setIgnoreThisBrowser(ignore: boolean): void {
  write(IGNORE_KEY, ignore ? "1" : null);
}

export function ignoringThisBrowser(): boolean {
  return read(IGNORE_KEY) === "1";
}

/** Sends one event. Never throws, never blocks the page. */
export function trackEvent(name: ClientEventName, props?: Record<string, string>): void {
  try {
    if (state.disabled || typeof window === "undefined" || optedOut()) return;
    const path = window.location.pathname;
    if (excludedPath(path)) return;

    const body: Record<string, unknown> = { id: uuid(), name, path };
    if (props && Object.keys(props).length) body.props = props;
    if (name === "page_view" && !state.firstSent) {
      state.firstSent = true;
      if (document.referrer) body.referrer = document.referrer;
      const params = new URLSearchParams(window.location.search);
      const utm: Record<string, string> = {};
      for (const key of ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content"]) {
        const value = params.get(key);
        if (value) utm[key] = value.slice(0, 80);
      }
      if (Object.keys(utm).length) body.utm = utm;
    }
    // A visitor id only exists after the visitor said yes, and only while
    // the site is in "ask" mode.
    const vid = state.consentMode !== "none" && consentChoice() === "granted" ? read(VID_KEY) : null;
    if (vid) body.vid = vid;

    void fetch("/api/analytics/collect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      keepalive: true,
      credentials: "same-origin",
    })
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { enabled?: boolean; consent?: "ask" | "none" } | null) => {
        if (!data) return;
        if (data.enabled === false) {
          state.disabled = true;
          return;
        }
        if (data.consent && data.consent !== state.consentMode) {
          state.consentMode = data.consent;
          // The site went back to cookie-free mode: forget the id.
          if (data.consent === "none") write(VID_KEY, null);
          for (const fn of listeners) fn(data.consent);
        }
      })
      .catch(() => {
        /* analytics must never surface an error */
      });
  } catch {
    /* never */
  }
}
