import type { FeatureKey, PlanId } from "@/lib/plans";
import { isFeatureKey } from "@/lib/plans";

/**
 * Two shapes per entity: the snake_case row as SQLite returns it, and
 * the camelCase domain object the rest of the app uses. Mapping between
 * them is explicit so a column rename cannot silently reach the UI, and
 * so unions like `SubscriptionStatus` are re-asserted at the boundary
 * (SQLite has no enums).
 */

export type SubscriptionStatus = "active" | "expired" | "cancelled";
export type SubscriptionPaymentStatus = "paid" | "free" | "pending" | "failed";
export type PaymentStatus = "created" | "paid" | "failed" | "cancelled";
/** Whether real money moved. The gateway is recorded separately. */
export type PaymentMode = "live" | "mock";
export type GatewayId = "razorpay" | "cashfree" | "paypal";
export type GatewayEnvironment = "sandbox" | "live";
export type ReportState = "running" | "complete" | "failed";
export type Verdict = "ready" | "needs_improvement" | "not_ready";
export type IssueStatus = "pass" | "warn" | "fail";
export type IssuePriority = "high" | "medium" | "low";
export type AnalysisMode = "live" | "demo";
export type UserRole = "user" | "admin";
export type AccountStatus = "active" | "blocked";

export const GATEWAY_IDS: readonly GatewayId[] = ["razorpay", "cashfree", "paypal"];

export function isGatewayId(value: unknown): value is GatewayId {
  return typeof value === "string" && (GATEWAY_IDS as readonly string[]).includes(value);
}

/** Reads a JSON array of feature keys, dropping anything unrecognised. */
function featureList(json: string | null): FeatureKey[] {
  if (!json) return [];
  try {
    const parsed: unknown = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    return [...new Set(parsed.filter(isFeatureKey))];
  } catch {
    return [];
  }
}

function jsonArray<T>(json: string | null): T[] {
  if (!json) return [];
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

function jsonObject<T extends object>(json: string | null, fallback: T): T {
  if (!json) return fallback;
  try {
    const parsed: unknown = JSON.parse(json);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as T)
      : fallback;
  } catch {
    return fallback;
  }
}

/* ── users ──────────────────────────────────────────────────────── */

export type UserRow = {
  id: string;
  name: string;
  email: string;
  password_hash: string;
  created_at: number;
  updated_at: number;
  role: string;
  status: string;
  blocked_at: number | null;
  blocked_reason: string | null;
  last_active_at: number | null;
  /** Added in schema v3. Absent on rows read before the migration ran. */
  avatar_key?: string | null;
  /** Added in schema v5. NULL for accounts created before verification existed. */
  email_verified_at?: number | null;
};

/** Never contains the password hash. This is what leaves the server. */
export type User = {
  id: string;
  name: string;
  email: string;
  createdAt: number;
  role: UserRole;
  status: AccountStatus;
  blockedAt: number | null;
  blockedReason: string | null;
  lastActiveAt: number | null;
  isAdmin: boolean;
  isBlocked: boolean;
  /**
   * Same-origin URL of the profile photo, or null for the default
   * initials avatar. Built from the stored key, never from user input.
   */
  avatarUrl: string | null;
  /** When the address was confirmed by code; null if not recorded (older accounts). */
  emailVerifiedAt: number | null;
};

/** The only shape an avatar key may take: 24 url-safe chars + .webp */
export const AVATAR_KEY_PATTERN = /^[A-Za-z0-9_-]{24}\.webp$/;

export function avatarUrlFor(key: string | null | undefined): string | null {
  return key && AVATAR_KEY_PATTERN.test(key) ? `/api/avatars/${key}` : null;
}

export function toUser(row: UserRow): User {
  // An unrecognised value fails closed in both columns: an unknown role is
  // not an admin, and an unknown status is not permitted to act.
  const role: UserRole = row.role === "admin" ? "admin" : "user";
  const status: AccountStatus = row.status === "active" ? "active" : "blocked";
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    createdAt: row.created_at,
    role,
    status,
    blockedAt: row.blocked_at,
    blockedReason: row.blocked_reason,
    lastActiveAt: row.last_active_at,
    isAdmin: role === "admin",
    isBlocked: status !== "active",
    avatarUrl: avatarUrlFor(row.avatar_key),
    emailVerifiedAt: row.email_verified_at ?? null,
  };
}

/* ── subscriptions ──────────────────────────────────────────────── */

export type SubscriptionRow = {
  id: string;
  user_id: string;
  plan_id: string;
  plan_name: string;
  amount_paise: number;
  currency: string;
  scan_limit: number;
  scans_used: number;
  site_limit: number | null;
  validity_days: number;
  purchased_at: number;
  starts_at: number;
  expires_at: number;
  status: string;
  payment_status: string;
  payment_id: string | null;
  order_id: string | null;
  invoice_id: string | null;
  created_at: number;
  updated_at: number;
  cycle_start: number;
  cycle_end: number;
  cycle_index: number;
  cycle_reset_at: number | null;
  features_json: string;
  gateway: string | null;
  admin_note: string | null;
};

export type Subscription = {
  id: string;
  userId: string;
  planId: PlanId;
  planName: string;
  amountPaise: number;
  currency: string;
  /** Scans granted for the current billing month. */
  scanLimit: number;
  /** Scans spent inside the current billing month. */
  scansUsed: number;
  scansRemaining: number;
  siteLimit: number | null;
  purchasedAt: number;
  startsAt: number;
  expiresAt: number;
  status: SubscriptionStatus;
  paymentStatus: SubscriptionPaymentStatus;
  paymentId: string | null;
  orderId: string | null;
  invoiceId: string | null;
  /** Start of the current billing month. */
  cycleStart: number;
  /** When the current month's allowance resets. */
  cycleEnd: number;
  /** 1 for the first month, incrementing on each roll. */
  cycleIndex: number;
  /** The features this subscription was sold. A floor, never a ceiling. */
  features: FeatureKey[];
  gateway: GatewayId | null;
  adminNote: string | null;
  /** Whole days until the subscription itself ends, floored at 0. */
  daysRemaining: number;
  /** Whole days until the monthly allowance resets, floored at 0. */
  daysUntilReset: number;
  isExpired: boolean;
  /** The month's allowance is spent, but the subscription is fine. */
  isCapped: boolean;
  /** Active, in date, and has at least one scan left this month. */
  isUsable: boolean;
};

const DAY_MS = 86_400_000;

export function toSubscription(row: SubscriptionRow, now = Date.now()): Subscription {
  const status = row.status as SubscriptionStatus;
  const isExpired = row.expires_at <= now;
  const remaining = Math.max(0, row.scan_limit - row.scans_used);
  // A row written before cycles existed, or by a hand-edit, still has to
  // produce sensible dates rather than 1970.
  const cycleStart = row.cycle_start || row.starts_at;
  const cycleEnd = row.cycle_end || row.expires_at;
  return {
    id: row.id,
    userId: row.user_id,
    planId: row.plan_id as PlanId,
    planName: row.plan_name,
    amountPaise: row.amount_paise,
    currency: row.currency,
    scanLimit: row.scan_limit,
    scansUsed: row.scans_used,
    scansRemaining: remaining,
    siteLimit: row.site_limit,
    purchasedAt: row.purchased_at,
    startsAt: row.starts_at,
    expiresAt: row.expires_at,
    status,
    paymentStatus: row.payment_status as SubscriptionPaymentStatus,
    paymentId: row.payment_id,
    orderId: row.order_id,
    invoiceId: row.invoice_id,
    cycleStart,
    cycleEnd,
    cycleIndex: row.cycle_index || 1,
    features: featureList(row.features_json),
    gateway: isGatewayId(row.gateway) ? row.gateway : null,
    adminNote: row.admin_note,
    daysRemaining: Math.max(0, Math.ceil((row.expires_at - now) / DAY_MS)),
    daysUntilReset: Math.max(0, Math.ceil((cycleEnd - now) / DAY_MS)),
    isExpired,
    isCapped: remaining === 0,
    isUsable: status === "active" && !isExpired && remaining > 0,
  };
}

/* ── payments ───────────────────────────────────────────────────── */

export type PaymentRow = {
  id: string;
  user_id: string;
  subscription_id: string | null;
  plan_id: string;
  amount_paise: number;
  currency: string;
  status: string;
  mode: string;
  gateway_order_id: string;
  gateway_payment_id: string | null;
  method: string | null;
  failure_reason: string | null;
  receipt: string | null;
  created_at: number;
  updated_at: number;
  verified_at: number | null;
  gateway: string;
  environment: string | null;
  raw_status: string | null;
  /* schema v4 — absent on rows read before the migration ran */
  billing_name?: string | null;
  billing_email?: string | null;
  billing_phone?: string | null;
  billing_country?: string | null;
  idempotency_key?: string | null;
  handoff_json?: string | null;
};

export type Payment = {
  id: string;
  userId: string;
  subscriptionId: string | null;
  planId: PlanId;
  amountPaise: number;
  currency: string;
  status: PaymentStatus;
  mode: PaymentMode;
  gateway: GatewayId;
  environment: GatewayEnvironment | null;
  orderId: string;
  paymentId: string | null;
  method: string | null;
  failureReason: string | null;
  createdAt: number;
  verifiedAt: number | null;
  billingName: string | null;
  billingEmail: string | null;
  /** E.164 */
  billingPhone: string | null;
  billingCountry: string | null;
  updatedAt: number;
};

export function toPayment(row: PaymentRow): Payment {
  return {
    id: row.id,
    userId: row.user_id,
    subscriptionId: row.subscription_id,
    planId: row.plan_id as PlanId,
    amountPaise: row.amount_paise,
    currency: row.currency,
    status: row.status as PaymentStatus,
    mode: row.mode === "mock" ? "mock" : "live",
    gateway: isGatewayId(row.gateway) ? row.gateway : "razorpay",
    environment: row.environment === "live" ? "live" : row.environment === "sandbox" ? "sandbox" : null,
    orderId: row.gateway_order_id,
    paymentId: row.gateway_payment_id,
    method: row.method,
    failureReason: row.failure_reason,
    createdAt: row.created_at,
    verifiedAt: row.verified_at,
    billingName: row.billing_name ?? null,
    billingEmail: row.billing_email ?? null,
    billingPhone: row.billing_phone ?? null,
    billingCountry: row.billing_country ?? null,
    updatedAt: row.updated_at,
  };
}

/* ── payment gateway configuration ──────────────────────────────── */

export type PaymentGatewayRow = {
  id: string;
  enabled: number;
  environment: string;
  credentials_cipher: string | null;
  credential_tails_json: string;
  updated_at: number;
  updated_by: string | null;
};

/**
 * A gateway as the admin panel is allowed to see it.
 *
 * There is deliberately no field here that could hold a secret. The
 * ciphertext never leaves lib/payments, and the only thing the UI gets is
 * the last four characters of each credential, which is enough to answer
 * "is the right key installed?" and useless to anybody else.
 */
export type PaymentGatewayView = {
  id: GatewayId;
  enabled: boolean;
  environment: GatewayEnvironment;
  configured: boolean;
  /**
   * Where the credentials in force came from. An admin looking at a
   * gateway that reads from environment variables needs to know that
   * clearing the form will not clear the keys.
   */
  source: "database" | "environment" | "none";
  /** e.g. { keyId: "••••••••1234" } — masked, never the value. */
  masked: Record<string, string>;
  updatedAt: number;
  updatedBy: string | null;
  /**
   * Which checkout currencies this configuration can take, and why —
   * from the saved settings only. Contains no credential values.
   */
  currencies: Record<
    "INR" | "USD",
    { available: boolean; basis: "native" | "declared" | "settlement" | "unsupported"; reason: string }
  >;
};

/* ── webhook deliveries ─────────────────────────────────────────── */

export type WebhookOutcome = "processed" | "duplicate" | "ignored" | "rejected";

export type WebhookEventRow = {
  id: string;
  gateway: string;
  event_type: string | null;
  payload_hash: string;
  outcome: string;
  detail: string | null;
  received_at: number;
};

export type WebhookEvent = {
  id: string;
  gateway: string;
  eventType: string | null;
  outcome: WebhookOutcome;
  detail: string | null;
  receivedAt: number;
};

export function toWebhookEvent(row: WebhookEventRow): WebhookEvent {
  return {
    id: row.id,
    gateway: row.gateway,
    eventType: row.event_type,
    outcome: row.outcome as WebhookOutcome,
    detail: row.detail,
    receivedAt: row.received_at,
  };
}

/* ── admin audit log ────────────────────────────────────────────── */

export type AdminLogTargetType = "user" | "plan" | "subscription" | "gateway" | "system" | "support";

export type AdminLogRow = {
  id: string;
  admin_id: string | null;
  admin_email: string;
  action: string;
  target_type: string;
  target_id: string | null;
  target_label: string | null;
  detail: string | null;
  created_at: number;
};

export type AdminLogEntry = {
  id: string;
  adminId: string | null;
  adminEmail: string;
  action: string;
  targetType: AdminLogTargetType;
  targetId: string | null;
  targetLabel: string | null;
  detail: string | null;
  createdAt: number;
};

export function toAdminLogEntry(row: AdminLogRow): AdminLogEntry {
  return {
    id: row.id,
    adminId: row.admin_id,
    adminEmail: row.admin_email,
    action: row.action,
    targetType: row.target_type as AdminLogTargetType,
    targetId: row.target_id,
    targetLabel: row.target_label,
    detail: row.detail,
    createdAt: row.created_at,
  };
}

/* ── invoices ───────────────────────────────────────────────────── */

export type InvoiceRow = {
  id: string;
  number: string;
  user_id: string;
  payment_id: string;
  subscription_id: string | null;
  billing_name: string;
  billing_email: string;
  plan_name: string;
  amount_paise: number;
  currency: string;
  period_start: number;
  period_end: number;
  issued_at: number;
};

export type Invoice = {
  id: string;
  number: string;
  userId: string;
  paymentId: string;
  subscriptionId: string | null;
  billingName: string;
  billingEmail: string;
  planName: string;
  amountPaise: number;
  currency: string;
  periodStart: number;
  periodEnd: number;
  issuedAt: number;
};

export function toInvoice(row: InvoiceRow): Invoice {
  return {
    id: row.id,
    number: row.number,
    userId: row.user_id,
    paymentId: row.payment_id,
    subscriptionId: row.subscription_id,
    billingName: row.billing_name,
    billingEmail: row.billing_email,
    planName: row.plan_name,
    amountPaise: row.amount_paise,
    currency: row.currency,
    periodStart: row.period_start,
    periodEnd: row.period_end,
    issuedAt: row.issued_at,
  };
}

/* ── websites & reports ─────────────────────────────────────────── */

export type WebsiteRow = {
  id: string;
  user_id: string;
  domain: string;
  created_at: number;
  last_checked_at: number | null;
};

export type Website = {
  id: string;
  userId: string;
  domain: string;
  createdAt: number;
  lastCheckedAt: number | null;
};

export function toWebsite(row: WebsiteRow): Website {
  return {
    id: row.id,
    userId: row.user_id,
    domain: row.domain,
    createdAt: row.created_at,
    lastCheckedAt: row.last_checked_at,
  };
}

export type CategoryScore = {
  id: string;
  name: string;
  score: number;
  weight: number;
  passed: number;
  warnings: number;
  critical: number;
};

/** One crawled page, scored on its own. Pro's page-by-page view. */
export type PageScore = {
  url: string;
  path: string;
  title: string;
  status: number;
  words: number;
  score: number;
  issues: number;
  /** Estimated machine-written likelihood, 0–100. Null when not measured. */
  aiLikelihood: number | null;
};

/** One item of the Pro remediation plan, in the order to work through. */
export type Recommendation = {
  rank: number;
  title: string;
  /** The specific action, written against what we observed. */
  action: string;
  priority: IssuePriority;
  /** Findings this addresses, by check id. */
  from: string[];
  category: string;
};

/** One ranked entry of the Pro policy-risk list. */
export type PolicyRisk = {
  label: string;
  level: "high" | "moderate" | "low";
  why: string;
};

/** Numbers worth keeping beside the score, for the report's detail pane. */
export type ReportMetrics = {
  totalWords?: number;
  averageWords?: number;
  /** Estimated machine-written likelihood, 0–100. An estimate, not a verdict. */
  aiLikelihood?: number;
  aiBand?: "low" | "moderate" | "elevated";
  aiReliable?: boolean;
  humanSignalScore?: number;
  originality?: number;
  duplicatePairs?: number;
  duplicateShare?: number;
  adDensity?: number;
  adSlots?: number;
  sitemapUrls?: number;
  maxDepth?: number;
  averageDepth?: number;
  orphanPages?: number;
  brokenLinks?: number;
  riskLevel?: "low" | "moderate" | "elevated" | "high";
  /** Ordered remediation plan. Pro only. */
  recommendations?: Recommendation[];
  /** Ranked policy risks. Pro only. */
  risks?: PolicyRisk[];
};

export type ReportRow = {
  id: string;
  ref: string;
  user_id: string;
  website_id: string;
  subscription_id: string | null;
  url: string;
  domain: string;
  score: number;
  verdict: string;
  state: string;
  categories_json: string;
  passed_count: number;
  warning_count: number;
  critical_count: number;
  plan_id: string;
  plan_name: string;
  engine_version: string;
  analysis_mode: string;
  pages_fetched: number;
  error_message: string | null;
  started_at: number;
  finished_at: number | null;
  duration_ms: number | null;
  created_at: number;
  features_json: string;
  pages_json: string;
  metrics_json: string;
  checks_run: number;
  locked_json: string;
};

export type Report = {
  id: string;
  ref: string;
  userId: string;
  websiteId: string;
  subscriptionId: string | null;
  url: string;
  domain: string;
  score: number;
  verdict: Verdict;
  state: ReportState;
  categories: CategoryScore[];
  passedCount: number;
  warningCount: number;
  criticalCount: number;
  planId: PlanId;
  planName: string;
  engineVersion: string;
  analysisMode: AnalysisMode;
  pagesFetched: number;
  errorMessage: string | null;
  startedAt: number;
  finishedAt: number | null;
  durationMs: number | null;
  createdAt: number;
  /** Features the plan allowed when this ran. */
  features: FeatureKey[];
  /** Features a higher plan would have added. Drives the upgrade prompts. */
  locked: FeatureKey[];
  pages: PageScore[];
  metrics: ReportMetrics;
  checksRun: number;
};

export function toReport(row: ReportRow): Report {
  return {
    id: row.id,
    ref: row.ref,
    userId: row.user_id,
    websiteId: row.website_id,
    subscriptionId: row.subscription_id,
    url: row.url,
    domain: row.domain,
    score: row.score,
    verdict: row.verdict as Verdict,
    state: row.state as ReportState,
    categories: jsonArray<CategoryScore>(row.categories_json),
    passedCount: row.passed_count,
    warningCount: row.warning_count,
    criticalCount: row.critical_count,
    planId: row.plan_id as PlanId,
    planName: row.plan_name,
    engineVersion: row.engine_version,
    analysisMode: row.analysis_mode as AnalysisMode,
    pagesFetched: row.pages_fetched,
    errorMessage: row.error_message,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    durationMs: row.duration_ms,
    createdAt: row.created_at,
    features: featureList(row.features_json),
    locked: featureList(row.locked_json),
    pages: jsonArray<PageScore>(row.pages_json),
    metrics: jsonObject<ReportMetrics>(row.metrics_json, {}),
    checksRun: row.checks_run,
  };
}

export type ReportIssueRow = {
  id: string;
  report_id: string;
  check_id: string;
  category_id: string;
  label: string;
  status: string;
  priority: string;
  detail: string;
  recommendation: string | null;
  evidence: string | null;
  sort_order: number;
  feature: string | null;
};

export type ReportIssue = {
  id: string;
  reportId: string;
  checkId: string;
  categoryId: string;
  label: string;
  status: IssueStatus;
  priority: IssuePriority;
  detail: string;
  recommendation: string | null;
  evidence: string | null;
  /** The advertised feature that produced this finding, when known. */
  feature: FeatureKey | null;
};

export function toReportIssue(row: ReportIssueRow): ReportIssue {
  return {
    id: row.id,
    reportId: row.report_id,
    checkId: row.check_id,
    categoryId: row.category_id,
    label: row.label,
    status: row.status as IssueStatus,
    priority: row.priority as IssuePriority,
    detail: row.detail,
    recommendation: row.recommendation,
    evidence: row.evidence,
    feature: isFeatureKey(row.feature) ? row.feature : null,
  };
}
