import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * Server-only configuration. Everything secret is read here and
 * nowhere else, so there is exactly one place to audit.
 *
 * Nothing in this file may be imported from a client component.
 */

export const IS_PROD = process.env.NODE_ENV === "production";

export const DATA_DIR =
  process.env.DATA_DIR?.trim() || path.join(process.cwd(), "data");

export function ensureDataDir(): string {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  return DATA_DIR;
}

export const APP_URL = (
  process.env.NEXT_PUBLIC_APP_URL?.trim() || "http://localhost:3000"
).replace(/\/+$/, "");

/** Whether APP_URL was set explicitly rather than defaulted. */
export const APP_URL_CONFIGURED = Boolean(process.env.NEXT_PUBLIC_APP_URL?.trim());

/**
 * Where profile photos are stored. Defaults to `<DATA_DIR>/avatars`, i.e.
 * the same persistent disk as the database. Override only to put photos
 * on a different mounted volume.
 */
export const AVATAR_DIR =
  process.env.AVATAR_DIR?.trim() || path.join(DATA_DIR, "avatars");

/* ── session signing secret ─────────────────────────────────────── */

let cachedSecret: string | null = null;

/**
 * In production AUTH_SECRET is mandatory. In development we persist a
 * random secret next to the database so sessions survive a restart
 * without asking you to configure anything to run the app.
 */
export function authSecret(): string {
  if (cachedSecret) return cachedSecret;

  const fromEnv = process.env.AUTH_SECRET?.trim();
  if (fromEnv && fromEnv.length >= 32) {
    cachedSecret = fromEnv;
    return cachedSecret;
  }

  if (IS_PROD) {
    throw new Error(
      "AUTH_SECRET is missing or too short. Set it to at least 32 random " +
        "characters before running in production. Generate one with: " +
        "openssl rand -base64 48",
    );
  }

  ensureDataDir();
  const file = path.join(DATA_DIR, ".dev-auth-secret");
  if (existsSync(file)) {
    cachedSecret = readFileSync(file, "utf8").trim();
  } else {
    const generated = randomBytes(48).toString("base64url");
    writeFileSync(file, generated, { mode: 0o600 });
    cachedSecret = generated;
    console.warn(
      "[auth] AUTH_SECRET not set. Generated a development-only secret at " +
        "data/.dev-auth-secret. Set AUTH_SECRET before deploying.",
    );
  }
  return cachedSecret;
}

/* ── credential encryption ──────────────────────────────────────── */

/**
 * The key that encrypts payment-gateway secrets at rest.
 *
 * A dedicated `CREDENTIALS_SECRET` is the right answer, because rotating
 * the session secret should not cost you every stored gateway key. If it
 * is absent we derive from AUTH_SECRET under a distinct HKDF label, so
 * the two uses can never end up sharing a derived key — that keeps a
 * fresh deployment working without a second variable, and the fallback is
 * called out in the README.
 */
export function credentialsSecret(): string {
  const fromEnv = process.env.CREDENTIALS_SECRET?.trim();
  if (fromEnv && fromEnv.length >= 32) return fromEnv;

  if (IS_PROD && !process.env.AUTH_SECRET?.trim()) {
    throw new Error(
      "CREDENTIALS_SECRET (or AUTH_SECRET) is required to encrypt payment " +
        "gateway credentials. Generate one with: openssl rand -base64 48",
    );
  }
  return authSecret();
}

/* ── first admin ────────────────────────────────────────────────── */

/**
 * Bootstrap account for the admin panel, applied on database open.
 *
 * Both variables must be present for anything to happen. The password is
 * hashed with the same scrypt parameters as any other account and is
 * never stored in plain text; if the account already exists only its role
 * is raised, so redeploying does not reset a password an admin changed.
 */
export const ADMIN_EMAIL = process.env.ADMIN_EMAIL?.trim().toLowerCase() ?? "";
export const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? "";
export const ADMIN_NAME = process.env.ADMIN_NAME?.trim() || "Administrator";

/* ── payments ───────────────────────────────────────────────────── */

/**
 * Environment credentials are a *seed and a fallback*. The live source of
 * truth is the `payment_gateways` table, which an admin edits at
 * /admin/payment-gateways; these values are used when that table has no
 * row for a gateway, so an env-only deployment keeps working and a fresh
 * install has something to start from.
 */
export const RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID?.trim() ?? "";
export const RAZORPAY_KEY_SECRET =
  process.env.RAZORPAY_KEY_SECRET?.trim() ?? "";
export const RAZORPAY_WEBHOOK_SECRET =
  process.env.RAZORPAY_WEBHOOK_SECRET?.trim() ?? "";

export const CASHFREE_APP_ID = process.env.CASHFREE_APP_ID?.trim() ?? "";
export const CASHFREE_SECRET_KEY =
  process.env.CASHFREE_SECRET_KEY?.trim() ?? "";
export const CASHFREE_WEBHOOK_SECRET =
  process.env.CASHFREE_WEBHOOK_SECRET?.trim() ?? "";
export const CASHFREE_ENVIRONMENT =
  process.env.CASHFREE_ENVIRONMENT?.trim() === "live" ? "live" : "sandbox";

export const PAYPAL_CLIENT_ID = process.env.PAYPAL_CLIENT_ID?.trim() ?? "";
export const PAYPAL_CLIENT_SECRET =
  process.env.PAYPAL_CLIENT_SECRET?.trim() ?? "";
export const PAYPAL_WEBHOOK_ID = process.env.PAYPAL_WEBHOOK_ID?.trim() ?? "";
export const PAYPAL_ENVIRONMENT =
  process.env.PAYPAL_ENVIRONMENT?.trim() === "live" ? "live" : "sandbox";

/**
 * The local simulator. Refuses to run in production and must be switched
 * on deliberately. When it is on and no gateway is configured, checkout
 * completes against a fake order so the purchase → subscription → report
 * flow stays testable; every row it writes is stamped mode='mock'.
 */
export const PAYMENTS_MOCK_MODE =
  !IS_PROD && process.env.PAYMENTS_MODE?.trim() === "mock";

export type PaymentsMode = "live" | "mock" | "unconfigured";

/**
 * Whether real money can move, considering environment variables only.
 *
 * This cannot see the admin-configured gateways — a route that needs the
 * true answer should ask `lib/payments`, which reads the database. This
 * remains for the env-only fallback and for the settings copy.
 */
export function paymentsMode(): PaymentsMode {
  if (RAZORPAY_KEY_ID && RAZORPAY_KEY_SECRET) return "live";
  if (CASHFREE_APP_ID && CASHFREE_SECRET_KEY) return "live";
  if (PAYPAL_CLIENT_ID && PAYPAL_CLIENT_SECRET) return "live";
  if (PAYMENTS_MOCK_MODE) return "mock";
  return "unconfigured";
}

export function razorpayIsLiveKey(): boolean {
  return RAZORPAY_KEY_ID.startsWith("rzp_live_");
}

/* ── analysis engine ────────────────────────────────────────────── */

function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** Pages fetched per audit, including the homepage. Keeps audits polite. */
export const ANALYSIS_MAX_PAGES = intFromEnv("ANALYSIS_MAX_PAGES", 6);
export const ANALYSIS_TIMEOUT_MS = intFromEnv("ANALYSIS_TIMEOUT_MS", 12_000);
export const ANALYSIS_USER_AGENT =
  process.env.ANALYSIS_USER_AGENT?.trim() ||
  "AdSenseEligibilityChecker/1.0 (+audit bot; respects robots.txt)";

/**
 * Escape hatch for auditing a site on your own LAN during development.
 * Off by default: with it off we refuse to fetch private address space,
 * which is what stops the analyser being used as an SSRF proxy.
 */
export const ALLOW_PRIVATE_ANALYSIS_HOSTS =
  !IS_PROD && process.env.ALLOW_PRIVATE_ANALYSIS_HOSTS?.trim() === "true";

/**
 * Development convenience for machines with no outbound network (CI
 * sandboxes, offline work). When a site genuinely cannot be reached and
 * this is on, the audit records a clearly-labelled demo report instead
 * of failing, so the checker → report → history flow stays testable.
 *
 * Off by default and unavailable in production, because a fabricated
 * report presented as a real one would be a lie. Reports produced this
 * way are stored with analysis_mode = 'demo' permanently, and every
 * screen that shows them says so.
 */
export const ALLOW_DEMO_FALLBACK =
  !IS_PROD && process.env.ANALYSIS_DEMO_FALLBACK?.trim() === "true";
