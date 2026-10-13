import { many, one, run } from "@/lib/db";
import {
  GATEWAY_IDS,
  isGatewayId,
  type GatewayEnvironment,
  type GatewayId,
  type PaymentGatewayRow,
  type PaymentGatewayView,
} from "@/lib/db/types";
import {
  CASHFREE_APP_ID,
  CASHFREE_ENVIRONMENT,
  CASHFREE_SECRET_KEY,
  CASHFREE_WEBHOOK_SECRET,
  PAYPAL_CLIENT_ID,
  PAYPAL_CLIENT_SECRET,
  PAYPAL_ENVIRONMENT,
  PAYPAL_WEBHOOK_ID,
  RAZORPAY_KEY_ID,
  RAZORPAY_KEY_SECRET,
  RAZORPAY_WEBHOOK_SECRET,
  razorpayIsLiveKey,
} from "@/lib/env";
import { decryptSecret, encryptSecret, maskTail } from "@/lib/secrets";

import { GATEWAYS } from "./registry";
import type { GatewayConfig, GatewayCredentials } from "./types";

/**
 * Where gateway credentials live, and who is allowed to see them.
 *
 * The database row is authoritative. Environment variables are a seed and
 * a fallback, so an existing env-only deployment keeps working and a fresh
 * install has something to start from; the moment an admin saves
 * credentials for a gateway, the row wins.
 *
 * Secrets are stored as one AES-256-GCM ciphertext over a JSON bag rather
 * than column-per-secret. That way adding a field to a gateway does not
 * need a migration, and there is exactly one thing to encrypt and one
 * thing to audit.
 *
 * Two functions leave this module with different privileges, and the
 * distinction is the whole point:
 *
 *   `gatewayConfig`  server-only, has the plaintext, never serialised
 *   `gatewayViews`   safe for the admin panel, carries only masked tails
 *
 * Nothing here may be imported from a client component.
 */

/* ── the environment fallback ───────────────────────────────────── */

function envCredentials(id: GatewayId): GatewayCredentials {
  switch (id) {
    case "razorpay":
      return prune({
        keyId: RAZORPAY_KEY_ID,
        keySecret: RAZORPAY_KEY_SECRET,
        webhookSecret: RAZORPAY_WEBHOOK_SECRET,
      });
    case "cashfree":
      return prune({
        appId: CASHFREE_APP_ID,
        secretKey: CASHFREE_SECRET_KEY,
        webhookSecret: CASHFREE_WEBHOOK_SECRET,
      });
    case "paypal":
      return prune({
        clientId: PAYPAL_CLIENT_ID,
        clientSecret: PAYPAL_CLIENT_SECRET,
        webhookId: PAYPAL_WEBHOOK_ID,
      });
  }
}

function envEnvironment(id: GatewayId): GatewayEnvironment {
  switch (id) {
    case "razorpay":
      // Razorpay encodes it in the key itself, which is better than a
      // separate setting that can disagree with the key in use.
      return razorpayIsLiveKey() ? "live" : "sandbox";
    case "cashfree":
      return CASHFREE_ENVIRONMENT;
    case "paypal":
      return PAYPAL_ENVIRONMENT;
  }
}

function prune(bag: GatewayCredentials): GatewayCredentials {
  const out: GatewayCredentials = {};
  for (const [key, value] of Object.entries(bag)) {
    const trimmed = value?.trim() ?? "";
    if (trimmed) out[key] = trimmed;
  }
  return out;
}

/* ── reading ────────────────────────────────────────────────────── */

function readRow(id: GatewayId): PaymentGatewayRow | null {
  return one<PaymentGatewayRow>("SELECT * FROM payment_gateways WHERE id = ?", [
    id,
  ]);
}

function credentialsFromRow(row: PaymentGatewayRow): GatewayCredentials {
  const plain = decryptSecret(row.credentials_cipher);
  if (!plain) return {};
  try {
    const parsed: unknown = JSON.parse(plain);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const bag: GatewayCredentials = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "string") bag[key] = value;
    }
    return prune(bag);
  } catch {
    return {};
  }
}

/**
 * The full configuration for one gateway, plaintext secrets included.
 *
 * Callers must keep the result server-side. It is never returned from a
 * route handler and never passed into a client component.
 */
export function gatewayConfig(id: GatewayId): GatewayConfig {
  const row = readRow(id);
  const fromRow = row ? credentialsFromRow(row) : {};
  const gateway = GATEWAYS[id];

  if (row && gateway.isConfigured(fromRow)) {
    return {
      id,
      enabled: row.enabled === 1,
      environment: row.environment === "live" ? "live" : "sandbox",
      credentials: fromRow,
      source: "database",
    };
  }

  const fromEnv = envCredentials(id);
  if (gateway.isConfigured(fromEnv)) {
    return {
      id,
      // A row may still control the on/off switch even when the
      // credentials came from the environment — an admin must be able to
      // disable a gateway they cannot re-key.
      enabled: row ? row.enabled === 1 : true,
      environment: row ? (row.environment === "live" ? "live" : "sandbox") : envEnvironment(id),
      credentials: fromEnv,
      source: "environment",
    };
  }

  return {
    id,
    enabled: false,
    environment: row ? (row.environment === "live" ? "live" : "sandbox") : envEnvironment(id),
    credentials: {},
    source: "none",
  };
}

/** Every gateway's configuration. Server-only, same rules as above. */
export function allGatewayConfigs(): GatewayConfig[] {
  return GATEWAY_IDS.map(gatewayConfig);
}

/**
 * Gateways a customer may actually choose right now.
 *
 * Configured *and* switched on. A gateway with credentials but disabled is
 * absent, which is what makes the admin toggle meaningful.
 */
export function enabledGatewayConfigs(): GatewayConfig[] {
  return allGatewayConfigs().filter(
    (config) => config.enabled && config.source !== "none",
  );
}

/* ── the admin panel's view ─────────────────────────────────────── */

/**
 * What the admin panel is allowed to render.
 *
 * Only the last four characters of each secret survive, which answers
 * "did the right key get saved?" without handing back the key. A
 * non-secret field like a Razorpay key id is shown in full: it is public
 * by design, it appears in the browser at checkout anyway, and masking it
 * would only make the panel harder to use for no gain.
 */
export function gatewayViews(): PaymentGatewayView[] {
  return GATEWAY_IDS.map((id) => {
    const config = gatewayConfig(id);
    const gateway = GATEWAYS[id];
    const masked: Record<string, string> = {};

    for (const field of gateway.fields) {
      const value = config.credentials[field.key] ?? "";
      if (!value) continue;
      masked[field.key] = field.secret ? maskTail(value) : value;
    }

    const row = readRow(id);
    return {
      id,
      enabled: config.enabled && config.source !== "none",
      environment: config.environment,
      configured: config.source !== "none",
      source: config.source,
      masked,
      updatedAt: row?.updated_at ?? 0,
      updatedBy: row?.updated_by ?? null,
      currencies: gateway.currencySupport(config.credentials),
    };
  });
}

/** One gateway's view, or null for an unknown id. */
export function gatewayView(id: unknown): PaymentGatewayView | null {
  if (!isGatewayId(id)) return null;
  return gatewayViews().find((view) => view.id === id) ?? null;
}

/* ── writing ────────────────────────────────────────────────────── */

function ensureRow(id: GatewayId, now: number): PaymentGatewayRow {
  const existing = readRow(id);
  if (existing) return existing;

  const row: PaymentGatewayRow = {
    id,
    enabled: 0,
    environment: envEnvironment(id),
    credentials_cipher: null,
    credential_tails_json: "{}",
    updated_at: now,
    updated_by: null,
  };
  run(
    `INSERT INTO payment_gateways
       (id, enabled, environment, credentials_cipher, credential_tails_json,
        updated_at, updated_by)
     VALUES (?,?,?,?,?,?,?)`,
    [
      row.id,
      row.enabled,
      row.environment,
      row.credentials_cipher,
      row.credential_tails_json,
      row.updated_at,
      row.updated_by,
    ],
  );
  return row;
}

export type SaveCredentialsResult =
  | { ok: true; view: PaymentGatewayView; changed: string[] }
  | { ok: false; message: string };

/**
 * Saves credentials for one gateway.
 *
 * A field submitted empty is *left alone* rather than cleared. The admin
 * panel can only ever show a mask, so an empty box means "I did not
 * retype this secret", not "delete it". Clearing is a separate, explicit
 * action.
 *
 * Enabling is refused unless the resulting credential bag is complete —
 * a gateway switched on with half a key would fail at checkout in front
 * of a customer, which is the worst place to discover it.
 */
export function saveGatewayCredentials(input: {
  id: GatewayId;
  values: Record<string, string>;
  /** Field keys to blank out deliberately. */
  clear?: string[];
  environment?: GatewayEnvironment;
  enabled?: boolean;
  actorEmail: string;
}): SaveCredentialsResult {
  const gateway = GATEWAYS[input.id];
  const now = Date.now();
  const row = ensureRow(input.id, now);

  const existing = credentialsFromRow(row);
  // Start from whatever is in force, so saving one field does not wipe
  // credentials that arrived from the environment.
  const base =
    Object.keys(existing).length > 0 ? existing : envCredentials(input.id);
  const next: GatewayCredentials = { ...base };
  const changed: string[] = [];

  for (const field of gateway.fields) {
    const submitted = input.values[field.key];
    if (typeof submitted !== "string") continue;
    const trimmed = submitted.trim();
    if (!trimmed) continue;
    if (next[field.key] !== trimmed) changed.push(field.label);
    next[field.key] = trimmed;
  }

  for (const key of input.clear ?? []) {
    if (next[key] !== undefined) {
      delete next[key];
      const field = gateway.fields.find((entry) => entry.key === key);
      changed.push(`${field?.label ?? key} cleared`);
    }
  }

  const wantsEnabled = input.enabled ?? row.enabled === 1;
  if (wantsEnabled && !gateway.isConfigured(next)) {
    const missing = gateway.fields
      .filter((field) => !field.optional && !next[field.key])
      .map((field) => field.label);
    return {
      ok: false,
      message: `${gateway.label} cannot be enabled yet. Still needed: ${missing.join(", ")}.`,
    };
  }

  const environment = input.environment ?? (row.environment === "live" ? "live" : "sandbox");
  const tails: Record<string, string> = {};
  for (const field of gateway.fields) {
    const value = next[field.key];
    if (value) tails[field.key] = value.slice(-4);
  }

  run(
    `UPDATE payment_gateways
        SET enabled = ?, environment = ?, credentials_cipher = ?,
            credential_tails_json = ?, updated_at = ?, updated_by = ?
      WHERE id = ?`,
    [
      wantsEnabled ? 1 : 0,
      environment,
      Object.keys(next).length > 0 ? encryptSecret(JSON.stringify(next)) : null,
      JSON.stringify(tails),
      now,
      input.actorEmail,
      input.id,
    ],
  );

  if (input.enabled !== undefined && (row.enabled === 1) !== input.enabled) {
    changed.push(input.enabled ? "enabled" : "disabled");
  }
  if (environment !== row.environment) {
    changed.push(`environment → ${environment}`);
  }

  return {
    ok: true,
    view: gatewayView(input.id)!,
    changed,
  };
}

/**
 * The on/off switch on its own.
 *
 * Enabling still requires complete credentials, for the same reason as
 * above: the toggle must not be able to promise a gateway we cannot
 * actually call.
 */
export function setGatewayEnabled(
  id: GatewayId,
  enabled: boolean,
  actorEmail: string,
): SaveCredentialsResult {
  return saveGatewayCredentials({ id, values: {}, enabled, actorEmail });
}

export function setGatewayEnvironment(
  id: GatewayId,
  environment: GatewayEnvironment,
  actorEmail: string,
): SaveCredentialsResult {
  return saveGatewayCredentials({ id, values: {}, environment, actorEmail });
}

/** Rows as stored, for the admin panel's "last updated" column. */
export function gatewayRows(): PaymentGatewayRow[] {
  return many<PaymentGatewayRow>("SELECT * FROM payment_gateways");
}
