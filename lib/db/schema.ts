/**
 * Schema as ordered, append-only migrations. `PRAGMA user_version`
 * records how many have run, so an existing database upgrades itself
 * on boot and never re-runs a migration.
 *
 * Never edit a migration that has shipped. Add a new one.
 *
 * Money is INTEGER paise. Timestamps are INTEGER milliseconds since
 * epoch (UTC) — comparable, sortable, and unambiguous across zones.
 * SQLite has no boolean or enum type, so flags are 0/1 and the union
 * types are enforced in TypeScript at the repository boundary.
 */

const V1 = `
CREATE TABLE users (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  email          TEXT NOT NULL UNIQUE,
  password_hash  TEXT NOT NULL,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);

-- Session id is the SHA-256 of the cookie token, never the token
-- itself: a stolen database cannot be replayed as a live session.
CREATE TABLE sessions (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at    INTEGER NOT NULL,
  last_seen_at  INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL,
  user_agent    TEXT,
  ip            TEXT
);
CREATE INDEX idx_sessions_user    ON sessions(user_id);
CREATE INDEX idx_sessions_expires ON sessions(expires_at);

-- Mirror of lib/plans.ts. Code stays the source of truth; this table
-- exists so plans are joinable and so historical rows can point at a
-- plan that has since been re-priced.
CREATE TABLE plans (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  amount_paise   INTEGER NOT NULL,
  currency       TEXT NOT NULL,
  check_limit    INTEGER NOT NULL,
  validity_days  INTEGER NOT NULL,
  site_limit     INTEGER,
  purchasable    INTEGER NOT NULL DEFAULT 0,
  synced_at      INTEGER NOT NULL
);

-- A purchase. Plan attributes are snapshotted so re-pricing a plan
-- never rewrites what somebody already bought.
CREATE TABLE subscriptions (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan_id         TEXT NOT NULL,
  plan_name       TEXT NOT NULL,
  amount_paise    INTEGER NOT NULL,
  currency        TEXT NOT NULL DEFAULT 'INR',
  check_limit     INTEGER NOT NULL,
  checks_used     INTEGER NOT NULL DEFAULT 0,
  site_limit      INTEGER,
  validity_days   INTEGER NOT NULL,
  purchased_at    INTEGER NOT NULL,
  starts_at       INTEGER NOT NULL,
  expires_at      INTEGER NOT NULL,
  status          TEXT NOT NULL,          -- active | expired | cancelled
  payment_status  TEXT NOT NULL,          -- paid | free | pending | failed
  payment_id      TEXT,
  order_id        TEXT,
  invoice_id      TEXT,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
CREATE INDEX idx_subs_user   ON subscriptions(user_id, status);
CREATE INDEX idx_subs_expiry ON subscriptions(expires_at);

-- One row per Razorpay order. The UNIQUE on order id is what makes
-- verification idempotent under duplicate callbacks.
CREATE TABLE payments (
  id                  TEXT PRIMARY KEY,
  user_id             TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  subscription_id     TEXT,
  plan_id             TEXT NOT NULL,
  amount_paise        INTEGER NOT NULL,
  currency            TEXT NOT NULL DEFAULT 'INR',
  status              TEXT NOT NULL,      -- created | paid | failed | cancelled
  mode                TEXT NOT NULL,      -- razorpay | mock
  razorpay_order_id   TEXT NOT NULL UNIQUE,
  razorpay_payment_id TEXT UNIQUE,
  method              TEXT,
  failure_reason      TEXT,
  receipt             TEXT,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,
  verified_at         INTEGER
);
CREATE INDEX idx_payments_user ON payments(user_id, created_at DESC);

CREATE TABLE invoices (
  id               TEXT PRIMARY KEY,
  number           TEXT NOT NULL UNIQUE,
  user_id          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  payment_id       TEXT NOT NULL REFERENCES payments(id) ON DELETE CASCADE,
  subscription_id  TEXT,
  billing_name     TEXT NOT NULL,
  billing_email    TEXT NOT NULL,
  plan_name        TEXT NOT NULL,
  amount_paise     INTEGER NOT NULL,
  currency         TEXT NOT NULL DEFAULT 'INR',
  period_start     INTEGER NOT NULL,
  period_end       INTEGER NOT NULL,
  issued_at        INTEGER NOT NULL
);
CREATE INDEX idx_invoices_user ON invoices(user_id, issued_at DESC);

CREATE TABLE websites (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  domain          TEXT NOT NULL,
  created_at      INTEGER NOT NULL,
  last_checked_at INTEGER,
  UNIQUE(user_id, domain)
);

CREATE TABLE reports (
  id               TEXT PRIMARY KEY,
  ref              TEXT NOT NULL,
  user_id          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  website_id       TEXT NOT NULL REFERENCES websites(id) ON DELETE CASCADE,
  subscription_id  TEXT,
  url              TEXT NOT NULL,
  domain           TEXT NOT NULL,
  score            INTEGER NOT NULL DEFAULT 0,
  verdict          TEXT NOT NULL DEFAULT 'not_ready',   -- ready | needs_improvement | not_ready
  state            TEXT NOT NULL DEFAULT 'running',     -- running | complete | failed
  categories_json  TEXT NOT NULL DEFAULT '[]',
  passed_count     INTEGER NOT NULL DEFAULT 0,
  warning_count    INTEGER NOT NULL DEFAULT 0,
  critical_count   INTEGER NOT NULL DEFAULT 0,
  plan_id          TEXT NOT NULL,
  plan_name        TEXT NOT NULL,
  engine_version   TEXT NOT NULL,
  -- 'live' = the site was actually fetched. 'demo' = sample data.
  analysis_mode    TEXT NOT NULL DEFAULT 'live',
  pages_fetched    INTEGER NOT NULL DEFAULT 0,
  error_message    TEXT,
  started_at       INTEGER NOT NULL,
  finished_at      INTEGER,
  duration_ms      INTEGER,
  created_at       INTEGER NOT NULL
);
CREATE INDEX idx_reports_user ON reports(user_id, created_at DESC);
CREATE INDEX idx_reports_site ON reports(website_id, created_at DESC);

CREATE TABLE report_issues (
  id              TEXT PRIMARY KEY,
  report_id       TEXT NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
  check_id        TEXT NOT NULL,
  category_id     TEXT NOT NULL,
  label           TEXT NOT NULL,
  status          TEXT NOT NULL,   -- pass | warn | fail
  priority        TEXT NOT NULL,   -- high | medium | low
  detail          TEXT NOT NULL,
  recommendation  TEXT,
  evidence        TEXT,
  sort_order      INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_issues_report ON report_issues(report_id, sort_order);
`;

/**
 * V2 — three monthly plans, admin, multi-gateway payments.
 *
 * Renames rather than duplicates where the meaning changed: a
 * subscription's "checks" allowance became a per-month scan allowance, and
 * a payment's "razorpay order" became a gateway order. Adding parallel
 * columns instead would leave two places to update and one of them
 * eventually wrong.
 */
const V2 = `
-- ── users: roles and account status ────────────────────────────────
ALTER TABLE users ADD COLUMN role           TEXT NOT NULL DEFAULT 'user';   -- user | admin
ALTER TABLE users ADD COLUMN status         TEXT NOT NULL DEFAULT 'active'; -- active | blocked
ALTER TABLE users ADD COLUMN blocked_at     INTEGER;
ALTER TABLE users ADD COLUMN blocked_reason TEXT;
ALTER TABLE users ADD COLUMN last_active_at INTEGER;
CREATE INDEX idx_users_role   ON users(role);
CREATE INDEX idx_users_status ON users(status);

-- ── plans: now editable by an admin, so the table is authoritative
-- for price and limits while lib/plans.ts remains the seed and the
-- fallback. V1's mirror had no rows worth keeping.
DROP TABLE plans;
CREATE TABLE plans (
  id                TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  tagline           TEXT NOT NULL DEFAULT '',
  amount_paise      INTEGER NOT NULL,
  currency          TEXT NOT NULL DEFAULT 'INR',
  billing_interval  TEXT NOT NULL DEFAULT 'month',
  site_limit        INTEGER NOT NULL,
  scan_limit        INTEGER NOT NULL,
  purchasable       INTEGER NOT NULL DEFAULT 0,
  featured          INTEGER NOT NULL DEFAULT 0,
  active            INTEGER NOT NULL DEFAULT 1,
  features_json     TEXT NOT NULL DEFAULT '[]',
  showcase_json     TEXT NOT NULL DEFAULT '[]',
  excluded_json     TEXT NOT NULL DEFAULT '[]',
  highlights_json   TEXT NOT NULL DEFAULT '[]',
  sort_order        INTEGER NOT NULL DEFAULT 0,
  updated_at        INTEGER NOT NULL,
  updated_by        TEXT
);

-- ── subscriptions: monthly cycles instead of a one-off allowance ───
ALTER TABLE subscriptions RENAME COLUMN check_limit TO scan_limit;
ALTER TABLE subscriptions RENAME COLUMN checks_used TO scans_used;
ALTER TABLE subscriptions ADD COLUMN cycle_start   INTEGER NOT NULL DEFAULT 0;
ALTER TABLE subscriptions ADD COLUMN cycle_end     INTEGER NOT NULL DEFAULT 0;
ALTER TABLE subscriptions ADD COLUMN cycle_index   INTEGER NOT NULL DEFAULT 1;
ALTER TABLE subscriptions ADD COLUMN cycle_reset_at INTEGER;
ALTER TABLE subscriptions ADD COLUMN features_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE subscriptions ADD COLUMN gateway       TEXT;
ALTER TABLE subscriptions ADD COLUMN admin_note    TEXT;
UPDATE subscriptions
   SET cycle_start = starts_at,
       cycle_end   = expires_at
 WHERE cycle_start = 0;

-- ── payments: one row per order at any gateway ─────────────────────
ALTER TABLE payments RENAME COLUMN razorpay_order_id   TO gateway_order_id;
ALTER TABLE payments RENAME COLUMN razorpay_payment_id TO gateway_payment_id;
ALTER TABLE payments ADD COLUMN gateway     TEXT NOT NULL DEFAULT 'razorpay';
ALTER TABLE payments ADD COLUMN environment TEXT;
ALTER TABLE payments ADD COLUMN raw_status  TEXT;
-- 'mode' used to carry the gateway name; it now says only whether the
-- money was real. The right-hand sides all read the pre-update row.
UPDATE payments
   SET gateway = CASE WHEN mode = 'mock' THEN 'razorpay' ELSE mode END,
       mode    = CASE WHEN mode = 'mock' THEN 'mock' ELSE 'live' END;

-- ── gateway configuration, secrets encrypted at rest ──────────────
CREATE TABLE payment_gateways (
  id                    TEXT PRIMARY KEY,   -- razorpay | cashfree | paypal
  enabled               INTEGER NOT NULL DEFAULT 0,
  environment           TEXT NOT NULL DEFAULT 'sandbox',  -- sandbox | live
  -- AES-256-GCM ciphertext of a JSON credential bag. Never plain text,
  -- and never returned to a browser.
  credentials_cipher    TEXT,
  -- Last four characters of each credential, so the admin panel can
  -- show which key is installed without being able to read it.
  credential_tails_json TEXT NOT NULL DEFAULT '{}',
  updated_at            INTEGER NOT NULL,
  updated_by            TEXT
);

-- Delivered webhooks, kept so a redelivery is recognised rather than
-- reprocessed. The primary key is the gateway's own event id.
CREATE TABLE webhook_events (
  id           TEXT PRIMARY KEY,
  gateway      TEXT NOT NULL,
  event_type   TEXT,
  payload_hash TEXT NOT NULL,
  outcome      TEXT NOT NULL,     -- processed | duplicate | ignored | rejected
  detail       TEXT,
  received_at  INTEGER NOT NULL
);
CREATE INDEX idx_webhook_events_time ON webhook_events(received_at DESC);

-- ── admin audit trail ─────────────────────────────────────────────
CREATE TABLE admin_logs (
  id           TEXT PRIMARY KEY,
  admin_id     TEXT,
  admin_email  TEXT NOT NULL,
  action       TEXT NOT NULL,
  target_type  TEXT NOT NULL,     -- user | plan | subscription | gateway
  target_id    TEXT,
  target_label TEXT,
  detail       TEXT,
  created_at   INTEGER NOT NULL
);
CREATE INDEX idx_admin_logs_time   ON admin_logs(created_at DESC);
CREATE INDEX idx_admin_logs_target ON admin_logs(target_type, target_id);

-- ── reports: what the plan allowed, and per-page detail ───────────
ALTER TABLE reports ADD COLUMN features_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE reports ADD COLUMN pages_json    TEXT NOT NULL DEFAULT '[]';
ALTER TABLE reports ADD COLUMN metrics_json  TEXT NOT NULL DEFAULT '{}';
ALTER TABLE reports ADD COLUMN checks_run    INTEGER NOT NULL DEFAULT 0;
ALTER TABLE reports ADD COLUMN locked_json   TEXT NOT NULL DEFAULT '[]';

-- Which advertised feature produced a finding, so the report can group
-- findings by feature and show what a cheaper plan did not run.
ALTER TABLE report_issues ADD COLUMN feature TEXT;
`;

/**
 * Profile photos.
 *
 * Only an opaque storage key is kept here — the image itself lives in the
 * avatar store (lib/avatars.ts), next to the database on the same disk.
 * Nullable with no default, so every existing account simply has no photo
 * and shows the initials avatar; nothing else about a row changes.
 */
const V3 = `
ALTER TABLE users ADD COLUMN avatar_key TEXT;
`;

/**
 * Checkout billing details and duplicate-order protection.
 *
 * All columns are nullable with no default: every existing payment keeps
 * exactly what it had, and invoices for those rows keep falling back to the
 * account's name and email as before.
 *
 * `idempotency_key` is generated by the checkout form, once per purchase
 * attempt. The partial UNIQUE index makes a double-submitted form (or a
 * retried request) map to the same order instead of opening a second one;
 * `handoff_json` is what lets the repeat be answered with the original
 * order. It holds only what the browser was already given — an order id,
 * a public key id, a hosted-checkout URL — never a secret.
 */
const V4 = `
ALTER TABLE payments ADD COLUMN billing_name    TEXT;
ALTER TABLE payments ADD COLUMN billing_email   TEXT;
ALTER TABLE payments ADD COLUMN billing_phone   TEXT;
ALTER TABLE payments ADD COLUMN billing_country TEXT;
ALTER TABLE payments ADD COLUMN idempotency_key TEXT;
ALTER TABLE payments ADD COLUMN handoff_json    TEXT;
CREATE UNIQUE INDEX idx_payments_idempotency
  ON payments(user_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
`;

/**
 * Email verification for new sign-ups, and "remember me".
 *
 * A sign-up no longer creates a user straight away. It writes a
 * `pending_registrations` row; the `users` row (and its free plan) is only
 * created once the emailed code is confirmed. So nothing in `users` is ever
 * unverified, and no page guard had to learn a new state.
 *
 *   flow_hash   HMAC of a random token held in an httpOnly cookie by the
 *               browser that signed up — the code only works there.
 *   code_hash   HMAC of the 6-digit code. The code itself is never stored.
 *               NULL once used up (too many wrong tries, or the email failed).
 *   decoy       1 when the address already has an account: the response and
 *               the flow look identical, so sign-up cannot be used to find
 *               out who is registered, but no code from it can ever succeed.
 *
 * `users.email_verified_at` is stamped when a code is confirmed. Accounts
 * that existed before this migration keep NULL: they were created under
 * the old flow (or by ADMIN_EMAIL) and stay fully usable — NULL means
 * "not recorded", not "unverified".
 *
 * `sessions.persistent` defaults to 1, which is exactly how every existing
 * session already behaves (a 30-day cookie).
 */
const V5 = `
CREATE TABLE pending_registrations (
  email            TEXT PRIMARY KEY,
  name             TEXT NOT NULL,
  password_hash    TEXT NOT NULL,
  decoy            INTEGER NOT NULL DEFAULT 0,
  flow_hash        TEXT NOT NULL UNIQUE,
  code_hash        TEXT,
  code_expires_at  INTEGER,
  attempts         INTEGER NOT NULL DEFAULT 0,
  last_sent_at     INTEGER,
  next_path        TEXT,
  created_at       INTEGER NOT NULL,
  expires_at       INTEGER NOT NULL
);
CREATE INDEX idx_pending_registrations_expires ON pending_registrations(expires_at);
ALTER TABLE users    ADD COLUMN email_verified_at INTEGER;
ALTER TABLE sessions ADD COLUMN persistent INTEGER NOT NULL DEFAULT 1;
`;

/**
 * A separate US-dollar price for each plan.
 *
 * `amount_paise` stays exactly what it was — the INR price — so no
 * existing price moves. The dollar price is its own column, set by an
 * admin; NULL means "not offered in USD", which checkout refuses rather
 * than guessing at a conversion. Free is $0 like it is ₹0.
 *
 * Nothing else changes: payments, subscriptions and invoices already
 * carry their own `currency` and amount, snapshotted at purchase. Every
 * existing row is INR and stays INR.
 */
const V6 = `
ALTER TABLE plans ADD COLUMN usd_amount_cents INTEGER;
UPDATE plans SET usd_amount_cents = 0 WHERE id = 'free';
`;

/**
 * Live chat support.
 *
 *   support_agents      the names and roles customers see in chat. Each
 *                       one can be linked to an existing *admin* account —
 *                       only admins can open the panel, so only a linked
 *                       agent can reply. The display role ("Admin",
 *                       "Member") is a label, not a permission.
 *   chat_conversations  one per customer: a signed-in account (user_id) or
 *                       a guest, identified only by the HMAC of a random
 *                       token held in an httpOnly cookie. Ids are random.
 *   chat_messages       plain text. `client_id` makes a double-sent message
 *                       land once.
 *
 * New tables only; nothing existing is altered.
 */
const V7 = `
CREATE TABLE support_agents (
  id             TEXT PRIMARY KEY,
  user_id        TEXT UNIQUE REFERENCES users(id) ON DELETE SET NULL,
  display_name   TEXT NOT NULL,
  role           TEXT NOT NULL DEFAULT 'member',   -- admin | member (a label)
  chat_enabled   INTEGER NOT NULL DEFAULT 1,       -- on the chat rota
  availability   TEXT NOT NULL DEFAULT 'available',-- available | away
  active         INTEGER NOT NULL DEFAULT 1,       -- 0 = deactivated
  last_seen_at   INTEGER,
  sort_order     INTEGER NOT NULL DEFAULT 0,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);

CREATE TABLE chat_conversations (
  id                    TEXT PRIMARY KEY,
  user_id               TEXT REFERENCES users(id) ON DELETE CASCADE,
  guest_token_hash      TEXT UNIQUE,
  guest_name            TEXT,
  guest_email           TEXT,
  status                TEXT NOT NULL DEFAULT 'open',  -- open | resolved
  assigned_agent_id     TEXT REFERENCES support_agents(id) ON DELETE SET NULL,
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL,
  last_message_at       INTEGER NOT NULL,
  last_message_preview  TEXT NOT NULL DEFAULT '',
  last_sender           TEXT,                          -- customer | agent
  customer_last_read_at INTEGER NOT NULL DEFAULT 0,
  agent_last_read_at    INTEGER NOT NULL DEFAULT 0,
  customer_last_seen_at INTEGER
);
CREATE UNIQUE INDEX idx_chat_conv_user ON chat_conversations(user_id) WHERE user_id IS NOT NULL;
CREATE INDEX idx_chat_conv_last ON chat_conversations(last_message_at DESC);

CREATE TABLE chat_messages (
  id               TEXT PRIMARY KEY,
  conversation_id  TEXT NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
  sender_type      TEXT NOT NULL,          -- customer | agent
  agent_id         TEXT REFERENCES support_agents(id) ON DELETE SET NULL,
  agent_name       TEXT,                   -- name shown at the time it was sent
  agent_role       TEXT,
  body             TEXT NOT NULL,
  client_id        TEXT,
  created_at       INTEGER NOT NULL
);
CREATE INDEX idx_chat_msg_conv ON chat_messages(conversation_id, created_at);
CREATE UNIQUE INDEX idx_chat_msg_client ON chat_messages(conversation_id, client_id) WHERE client_id IS NOT NULL;

-- The starting roster, inserted once here rather than on every boot, so a
-- deleted entry stays deleted. Not linked to any account: an admin links
-- each one to their own login from Admin → Support team.
INSERT INTO support_agents (id, display_name, role, chat_enabled, availability, active, sort_order, created_at, updated_at)
VALUES
  ('agt_' || lower(hex(randomblob(12))), 'Sandeep', 'admin',  1, 'available', 1, 0,
   CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000),
  ('agt_' || lower(hex(randomblob(12))), 'Gungun',  'member', 1, 'available', 1, 1,
   CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000);
`;

/**
 * Payment-failure and abandoned-checkout alerts.
 *
 *   app_settings       small key/value settings an admin edits (the alert
 *                      address, the abandonment grace period).
 *   checkout_sessions  billing details a signed-in customer saved on the
 *                      checkout page before paying. Becomes
 *                      payment_started when they press Pay, paid when the
 *                      payment settles, abandoned when the grace period
 *                      passes with no attempt. Never an order on its own.
 *   notifications      the alert outbox and its history. `dedupe_key` is
 *                      unique — one alert per failed order and one per
 *                      abandoned checkout, however many times the event
 *                      is seen. Delivery is claimed atomically
 *                      (status + locked_until), so overlapping job runs
 *                      cannot send the same alert twice.
 *
 * New tables only; nothing existing is altered.
 */
const V8 = `
CREATE TABLE app_settings (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_at  INTEGER NOT NULL,
  updated_by  TEXT
);

CREATE TABLE checkout_sessions (
  id                  TEXT PRIMARY KEY,
  user_id             TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan_id             TEXT NOT NULL,
  plan_name           TEXT NOT NULL,
  currency            TEXT NOT NULL,
  amount_minor        INTEGER NOT NULL,
  billing_name        TEXT NOT NULL,
  billing_email       TEXT NOT NULL,
  billing_phone       TEXT,
  billing_country     TEXT,
  status              TEXT NOT NULL DEFAULT 'in_progress', -- in_progress | payment_started | paid | abandoned | converted
  payment_order_id    TEXT,
  created_at          INTEGER NOT NULL,
  details_saved_at    INTEGER NOT NULL,
  payment_started_at  INTEGER,
  abandoned_at        INTEGER,
  updated_at          INTEGER NOT NULL
);
CREATE INDEX idx_checkout_sessions_status ON checkout_sessions(status, details_saved_at);
CREATE INDEX idx_checkout_sessions_user ON checkout_sessions(user_id, created_at DESC);
CREATE INDEX idx_checkout_sessions_order ON checkout_sessions(payment_order_id);

CREATE TABLE notifications (
  id               TEXT PRIMARY KEY,
  type             TEXT NOT NULL,              -- payment_failed | abandoned_checkout
  dedupe_key       TEXT NOT NULL UNIQUE,
  checkout_id      TEXT,
  order_id         TEXT,
  user_id          TEXT,
  destination      TEXT,
  status           TEXT NOT NULL,              -- pending | sending | retry | sent | failed | skipped
  attempts         INTEGER NOT NULL DEFAULT 0,
  next_attempt_at  INTEGER NOT NULL,
  locked_until     INTEGER,
  last_error       TEXT,
  provider         TEXT,
  provider_id      TEXT,
  payload_json     TEXT NOT NULL DEFAULT '{}', -- what the email shows; no credentials
  created_at       INTEGER NOT NULL,
  sent_at          INTEGER,
  updated_at       INTEGER NOT NULL
);
CREATE INDEX idx_notifications_due ON notifications(status, next_attempt_at);
CREATE INDEX idx_notifications_time ON notifications(created_at DESC);
`;

/**
 * First-party website analytics.
 *
 *   analytics_sessions  one row per visit. A visit ends after 30 minutes
 *                       with no event. Its id is made on the server; a
 *                       browser never chooses or sees it. Counters
 *                       (page_views, interactions) and the first/last page
 *                       are kept up to date as events arrive, so session
 *                       figures never need the whole event table.
 *   analytics_events    one row per event. `event_key` is unique: a
 *                       browser event carries a random id, and a server
 *                       event a natural one (`payment_succeeded:<order>`),
 *                       so a retried request or a repeated webhook cannot
 *                       add a second row.
 *
 * Privacy: no IP address, email, full URL or query string is stored.
 * `day_hash` is an HMAC of (IP, user agent) with a salt that is replaced
 * every UTC day and never kept, so it cannot be linked across days or
 * reversed. `visitor_key` is that daily hash, or — only for a browser
 * whose visitor agreed to be remembered — an HMAC of a random id the
 * browser holds. `path` is the pathname with ids collapsed to [id].
 *
 * New tables only; nothing existing is altered. Rows older than the
 * retention period (Admin → Website analytics → Settings) are deleted.
 */
const V9 = `
CREATE TABLE analytics_sessions (
  id                  TEXT PRIMARY KEY,
  visitor_key         TEXT NOT NULL,
  visitor_persistent  INTEGER NOT NULL DEFAULT 0,
  day_hash            TEXT NOT NULL,
  user_id             TEXT,
  started_at          INTEGER NOT NULL,
  last_seen_at        INTEGER NOT NULL,
  page_views          INTEGER NOT NULL DEFAULT 0,
  interactions        INTEGER NOT NULL DEFAULT 0,
  landing_path        TEXT,
  exit_path           TEXT,
  referrer_host       TEXT,
  referrer_type       TEXT NOT NULL DEFAULT 'direct', -- direct | search | social | email | paid | referral
  utm_source          TEXT,
  utm_medium          TEXT,
  utm_campaign        TEXT,
  utm_term            TEXT,
  utm_content         TEXT,
  device              TEXT,                            -- desktop | mobile | tablet
  browser             TEXT,
  os                  TEXT,
  country             TEXT,
  internal            INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_an_sessions_started ON analytics_sessions(started_at);
CREATE INDEX idx_an_sessions_day     ON analytics_sessions(day_hash, last_seen_at);
CREATE INDEX idx_an_sessions_visitor ON analytics_sessions(visitor_key, started_at);
CREATE INDEX idx_an_sessions_user    ON analytics_sessions(user_id, last_seen_at);

CREATE TABLE analytics_events (
  id           TEXT PRIMARY KEY,
  event_key    TEXT NOT NULL UNIQUE,
  name         TEXT NOT NULL,
  source       TEXT NOT NULL,          -- client | server
  occurred_at  INTEGER NOT NULL,       -- UTC milliseconds, server clock
  session_id   TEXT,
  visitor_key  TEXT,
  user_id      TEXT,
  path         TEXT,
  props_json   TEXT NOT NULL DEFAULT '{}',
  internal     INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_an_events_time    ON analytics_events(occurred_at);
CREATE INDEX idx_an_events_name    ON analytics_events(name, occurred_at);
CREATE INDEX idx_an_events_session ON analytics_events(session_id, occurred_at);
CREATE INDEX idx_an_events_visitor ON analytics_events(visitor_key, name, occurred_at);
CREATE INDEX idx_an_events_user    ON analytics_events(user_id, occurred_at);

-- Deleting an account also unlinks it from analytics.
CREATE TRIGGER trg_users_delete_analytics AFTER DELETE ON users BEGIN
  UPDATE analytics_events   SET user_id = NULL WHERE user_id = OLD.id;
  UPDATE analytics_sessions SET user_id = NULL WHERE user_id = OLD.id;
END;

-- Analytics reads these existing tables by date; none had a time index.
CREATE INDEX IF NOT EXISTS idx_users_created      ON users(created_at);
CREATE INDEX IF NOT EXISTS idx_reports_created    ON reports(created_at);
CREATE INDEX IF NOT EXISTS idx_payments_created   ON payments(created_at);
CREATE INDEX IF NOT EXISTS idx_payments_verified  ON payments(verified_at);
CREATE INDEX IF NOT EXISTS idx_subs_created       ON subscriptions(created_at);
CREATE INDEX IF NOT EXISTS idx_checkout_created   ON checkout_sessions(created_at);
`;

/** Append-only. Index 0 is version 1. */
export const MIGRATIONS: string[] = [V1, V2, V3, V4, V5, V6, V7, V8, V9];
