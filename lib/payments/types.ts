import type { GatewayEnvironment, GatewayId } from "@/lib/db/types";
import { CURRENCIES, type Currency } from "@/lib/money";

/**
 * One shape for three gateways that agree on almost nothing.
 *
 * Razorpay takes paise and signs `order|payment` with the API secret.
 * Cashfree takes rupees, issues a payment session and verifies by reading
 * the order back. PayPal takes dollars, needs an OAuth token first and
 * verifies webhooks by calling its own verification endpoint. Rather than
 * pretend those are the same thing, each adapter implements this contract
 * and keeps its own strangeness inside.
 *
 * Three rules hold for every adapter:
 *
 *  1. The amount charged comes from our plan record. An adapter converts
 *     units but never decides a price.
 *  2. `verifyReturn` must not trust anything the browser says. It either
 *     checks a signature made with a secret the browser cannot have, or it
 *     asks the gateway directly. "The frontend said it worked" is not a
 *     verification.
 *  3. Nothing here may be imported from a client component. The secrets
 *     live in this module's closure and must stay server-side.
 */

export type GatewayCredentials = Record<string, string>;

/** What a gateway needs configured, and how the admin panel labels it. */
export type CredentialField = {
  key: string;
  label: string;
  /** Shown under the input. Says where to find the value. */
  hint: string;
  /** A key id is not a secret; a key secret is. Only secrets are masked. */
  secret: boolean;
  /** Can the gateway work without it? Webhook secrets usually can. */
  optional?: boolean;
};

/** Resolved configuration for one gateway, secrets included. Server-only. */
export type GatewayConfig = {
  id: GatewayId;
  enabled: boolean;
  environment: GatewayEnvironment;
  credentials: GatewayCredentials;
  /** Where the credentials came from, for the admin panel's copy. */
  source: "database" | "environment" | "none";
};

export type OrderRequest = {
  /** Authoritative, in the smallest unit of `currency`. */
  amountPaise: number;
  currency: string;
  /** Our own receipt id, echoed back by the gateway where supported. */
  receipt: string;
  planId: string;
  planName: string;
  /** Monthly or yearly — for the order description only; the amount is already set. */
  billingCycle?: "monthly" | "yearly";
  userId: string;
  customerName: string;
  customerEmail: string;
  /**
   * Cashfree requires a contact number on the order and will reject the
   * request without one, so checkout collects it when Cashfree is the
   * chosen gateway. Absent for the others.
   */
  customerPhone?: string;
  /** Where the gateway should send the person after a hosted checkout. */
  returnUrl: string;
};

/**
 * What the browser needs to open checkout.
 *
 * `handoff` is deliberately narrow: an id, a public key, and at most a
 * redirect URL. No adapter may put a secret in here, and the checkout
 * component only ever reads these fields.
 */
export type OrderResult = {
  orderId: string;
  handoff:
    | { kind: "razorpay_checkout"; keyId: string; orderId: string }
    | { kind: "cashfree_session"; sessionId: string; mode: GatewayEnvironment }
    | { kind: "redirect"; url: string }
    | { kind: "mock"; orderId: string };
};

export type VerifiedPayment = {
  ok: true;
  orderId: string;
  gatewayPaymentId: string;
  method: string | null;
  /** In the smallest unit, for cross-checking against our own record. */
  amountPaise: number | null;
  currency: string | null;
  rawStatus: string | null;
};

export type VerificationFailure = {
  ok: false;
  /** `rejected` means it failed verification. `pending` means not final yet. */
  kind: "rejected" | "pending" | "cancelled" | "error";
  message: string;
  /**
   * True only when the provider itself reported the payment as failed or
   * declined — as opposed to our own check refusing it (a bad signature,
   * a mismatched order). Only these raise a "payment failed" alert.
   */
  providerConfirmed?: boolean;
};

export type VerifyResult = VerifiedPayment | VerificationFailure;

/** A webhook, after the signature has been checked. */
export type WebhookVerdict =
  | {
      ok: true;
      /** The gateway's own event id, used as the idempotency key. */
      eventId: string;
      eventType: string;
      /** Present when the event concerns a completed payment. */
      payment: {
        orderId: string;
        gatewayPaymentId: string;
        method: string | null;
        amountPaise: number | null;
        currency: string | null;
        rawStatus: string | null;
      } | null;
      /** A payment that definitively failed, so the row can be closed. */
      failure: { orderId: string; reason: string } | null;
    }
  | { ok: false; kind: "unsigned" | "invalid" | "malformed"; message: string };

/**
 * Whether checkout may send this currency to a gateway, and why.
 *
 * Decided from the saved configuration only — nothing here calls the
 * provider. `basis` says where the answer came from, so the admin panel
 * can be honest that "declared" means the operator told us their account
 * is approved, not that we asked the provider.
 */
export type CurrencySupport = {
  available: boolean;
  basis: "native" | "declared" | "settlement" | "unsupported";
  reason: string;
};

export type CurrencySupportMap = Record<Currency, CurrencySupport>;

/**
 * For Razorpay and Cashfree: INR always, other currencies only when the
 * operator has listed them as approved on their account. Both providers
 * accept USD orders through the same API, but only once international
 * payments are switched on for that merchant — so the default is off.
 */
export function declaredCurrencySupport(
  label: string,
  credentials: GatewayCredentials,
): CurrencySupportMap {
  const declared = new Set(
    (credentials.currencies ?? "")
      .split(/[\s,;]+/)
      .map((code) => code.trim().toUpperCase())
      .filter(Boolean),
  );
  const out = {} as CurrencySupportMap;
  for (const code of CURRENCIES) {
    if (code === "INR") {
      out[code] = { available: true, basis: "native", reason: `${label} accounts take INR by default.` };
    } else if (declared.has(code)) {
      out[code] = {
        available: true,
        basis: "declared",
        reason: `Listed under "Extra currencies" — make sure ${label} has approved ${code} payments on this account.`,
      };
    } else {
      out[code] = {
        available: false,
        basis: "unsupported",
        reason: `${label} only takes ${code} once international payments are enabled on your account. After ${label} approves it, add ${code} under "Extra currencies".`,
      };
    }
  }
  return out;
}

/** The shared "Extra currencies" field for gateways that use the rule above. */
export function extraCurrenciesField(label: string): CredentialField {
  return {
    key: "currencies",
    label: "Extra currencies",
    hint: `Currencies besides INR that ${label} has enabled on your account, e.g. USD. Leave empty for INR only. Adding a code here does not enable it at ${label}.`,
    secret: false,
    optional: true,
  };
}

export type Gateway = {
  id: GatewayId;
  label: string;
  /** One line under the radio button at checkout. */
  blurb: string;
  /** Payment methods, for the checkout copy. Nothing is implied beyond these. */
  methods: string[];
  fields: CredentialField[];
  /** True when every non-optional field has a value. */
  isConfigured(credentials: GatewayCredentials): boolean;
  /** Which checkout currencies this configuration can take. */
  currencySupport(credentials: GatewayCredentials): CurrencySupportMap;
  createOrder(config: GatewayConfig, request: OrderRequest): Promise<OrderResult>;
  /** Called from the browser callback, with whatever the gateway returned. */
  verifyReturn(
    config: GatewayConfig,
    payload: Record<string, unknown>,
  ): Promise<VerifyResult>;
  /** Called from the webhook route, over the exact raw body. */
  verifyWebhook(
    config: GatewayConfig,
    rawBody: string,
    headers: Headers,
  ): Promise<WebhookVerdict>;
};

export class GatewayError extends Error {
  constructor(
    message: string,
    readonly gateway: GatewayId,
    readonly status = 502,
  ) {
    super(message);
    this.name = "GatewayError";
  }
}

/**
 * Shared HTTP for the adapters.
 *
 * A hard timeout on every call, because a gateway that hangs must not
 * hold a request open indefinitely, and the parsed body is returned
 * alongside the raw text so an adapter can log what it actually got
 * without re-reading a consumed stream.
 */
export async function gatewayFetch(
  gateway: GatewayId,
  url: string,
  init: {
    method?: string;
    headers?: Record<string, string>;
    body?: unknown;
    /** Sent form-encoded instead of JSON. PayPal's OAuth endpoint wants this. */
    form?: Record<string, string>;
    timeoutMs?: number;
  } = {},
): Promise<{ status: number; ok: boolean; json: unknown; text: string }> {
  const form = init.form
    ? new URLSearchParams(init.form).toString()
    : undefined;

  let response: Response;
  try {
    response = await fetch(url, {
      method: init.method ?? "GET",
      headers: {
        Accept: "application/json",
        ...(form !== undefined
          ? { "Content-Type": "application/x-www-form-urlencoded" }
          : init.body === undefined
            ? {}
            : { "Content-Type": "application/json" }),
        ...init.headers,
      },
      body:
        form !== undefined
          ? form
          : init.body === undefined
            ? undefined
            : JSON.stringify(init.body),
      cache: "no-store",
      signal: AbortSignal.timeout(init.timeoutMs ?? 15_000),
    });
  } catch (error) {
    throw new GatewayError(
      `Could not reach the payment gateway: ${
        error instanceof Error ? error.message : "network error"
      }`,
      gateway,
    );
  }

  const text = await response.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* Not JSON. The caller falls back to the status. */
  }

  return { status: response.status, ok: response.ok, json, text };
}

/** Narrowing helper: adapters parse untyped gateway JSON constantly. */
export function pick(value: unknown, ...path: string[]): unknown {
  let current: unknown = value;
  for (const key of path) {
    if (!current || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

export function pickString(value: unknown, ...path: string[]): string | null {
  const found = pick(value, ...path);
  return typeof found === "string" && found.length > 0 ? found : null;
}

export function pickNumber(value: unknown, ...path: string[]): number | null {
  const found = pick(value, ...path);
  if (typeof found === "number" && Number.isFinite(found)) return found;
  if (typeof found === "string") {
    const parsed = Number.parseFloat(found);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}
