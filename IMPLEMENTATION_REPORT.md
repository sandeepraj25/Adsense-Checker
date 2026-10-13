# Implementation report

Verdict — AdSense Eligibility Checker. Everything below describes the state of
the repository as it stands now, verified by reading the code and by running
the checks in item 12.

---

## 1. What was already present

The homepage was complete and is **untouched**: `app/page.tsx`, every section in
`components/sections/` (Navbar, Hero, TrustBar, Stats, Process, Features,
ReportPreview, FinalCta, Footer), `components/illustrations/` including
`AuditCard.tsx`, and the design tokens in `app/globals.css`. Layout, type,
colour, spacing, animation and copy are exactly as they were.

Also already present before this work: the Next.js 15 / React 19 / Tailwind v4
scaffold, the shared UI primitives (`Container`, `Button`, `GlassCard`,
`ScoreArc`, `UrlForm`), `lib/checks.ts` (static demo data for the homepage
only), `lib/cn.ts`, `lib/domain.ts`, and the `ScanContext` used by the hero
preview.

## 2. What was fixed

**The SSRF false positive (“That address is not on the public internet”).** The
old filter refused legitimate public sites. The decision layer was rewritten,
not removed, and split into `lib/analysis/target.ts` (shape and scheme) and
`lib/analysis/net.ts` (addresses and hostnames). Public domains, bare domains,
`www.` forms, `http://` and `https://` all work now; `localhost`, `127.0.0.1`,
`::1`, `0.0.0.0`, private ranges (10/8, 172.16/12, 192.168/16), CGNAT
(100.64/10), link-local (169.254/16), the cloud metadata address
(169.254.169.254), multicast and reserved space are still refused — in IPv4 and
in IPv6, including `::ffff:` mapped, NAT64 `64:ff9b::/96` and 6to4 `2002::/16`
forms, plus reserved suffixes (`.local`, `.internal`, `.corp`, `.lan`,
`.onion`, …) and bare single-label hosts. A refusal now says it is a refusal and
a dead domain says it is unreachable; the two are no longer conflated.

**Failed scans piling up in history.** The address filter and the reachability
probe both run *before* the scan allowance is claimed and before any row is
written, so a refused or unreachable target creates no report, no website row
and costs no scan. A run that dies mid-flight (process restart) is closed by
`failStaleReports()`, which in the same transaction credits the scan back,
never below zero, and never twice for the same row.

**Plans.** The four-tier model with an Agency plan was replaced by exactly three
monthly tiers. No lifetime or one-off price exists anywhere in the product.

**Prices in more than one place.** `lib/plan-catalogue.ts` over the `plans`
table is now the single source of truth; `lib/plans.ts` holds only the shipped
defaults used to seed it. Nothing else hardcodes a price, an allowance or a
feature list.

## 3. New features

Accounts with scrypt password hashing and database-backed sessions. Three
monthly plans with server-enforced monthly cycles. Feature-gated analysis (13
checks on Free, 35 on Basic, 44 on Pro). Checkout across three gateways with
server-side verification, webhook settlement and invoices. A full admin panel:
stats, user management, plan editing, subscription and payment history,
encrypted gateway configuration, and an audit log. PDF export for Pro. Account
suspension. A 353-assertion verification suite.

Detail on the parts the brief called out specifically:

- **Enforcement, not display.** Every plan feature is checked server-side. The
  engine runs only the checks in the account's feature set; a locked check is
  not run, not computed and not stored, and the report names the features that
  would have added more. `/api/analysis` re-reads entitlement on every call, so
  calling it by hand grants nothing. The scan claim is a single
  `UPDATE … WHERE scans_used < scan_limit`, so two concurrent requests cannot
  both take the last scan.
- **Monthly, not lifetime.** Each subscription carries a cycle window, a
  `scans_used` counter and a cycle index. The cycle rolls on read and resets
  usage to zero, re-reading the plan's current limit — so an admin's new limit
  lands at renewal rather than mid-month.
- **Upgrade prompts that name a real plan.** A Free user who reaches for the AI
  content check is told which plan includes it and what it costs, read from the
  live catalogue, with an upgrade button. Move a feature between tiers in the
  admin panel and the sentence changes with it.
- **Feature changes in both directions.** A feature added to a plan reaches
  existing subscribers immediately. A feature removed is not clawed back from a
  month already paid for; it lapses at renewal.
- **Payment integrity.** `lib/billing/fulfil.ts` is the only code that can grant
  a plan. It requires a verified signature, then re-fetches the payment from the
  gateway and cross-checks amount and currency against the order. Fulfilment is
  keyed on the order and webhook processing on the gateway's event id, so a
  redelivery, a double-clicked redirect, or both racing returns the existing
  subscription instead of creating a second one. A short payment, a forged
  callback, a cancelled order and an unknown order all grant nothing and are
  recorded.
- **Credentials at rest.** Gateway secrets are encrypted with AES-256-GCM under
  a key from `CREDENTIALS_SECRET` (HKDF-derived from `AUTH_SECRET` if absent),
  never returned by any API, and shown to the admin masked to the last four
  characters. Saving a field empty keeps the stored secret. A gateway cannot be
  enabled until it is fully configured, and the refusal names what is missing.
- **Admin authorisation in depth.** Checked in middleware, in the page, in the
  API route and in the database read — not by hiding links. Every consequential
  change is written to `admin_logs` with the actor and a description of what
  changed, and those entries outlive the accounts they describe.
- **Honesty.** AI likelihood is reported as an estimate with a confidence band,
  never as a verdict. Originality is computed from the site's own pages and says
  so; no plagiarism-database claim is made, because no such provider is
  integrated. Nothing claims Google will approve a site. Reports built from
  seeded data are labelled demo data everywhere they appear.

## 4. Files created

117 new files. By area:

- `lib/db/` — `schema.ts`, `index.ts`, `types.ts`, `accounts.ts`, `billing.ts`,
  `audits.ts`, `admin.ts`, `webhooks.ts`
- `lib/auth/` — `password.ts`, `session.ts`, `cookie.ts`, `guard.ts`
- `lib/payments/` — `types.ts`, `registry.ts`, `config.ts`, `razorpay.ts`,
  `cashfree.ts`, `paypal.ts`, `index.ts`
- `lib/analysis/` — `types.ts`, `target.ts`, `net.ts`, `fetcher.ts`, `html.ts`,
  `signals.ts`, `checks.ts`, `engine.ts`, `demo.ts`
- `lib/` — `plans.ts`, `plan-catalogue.ts`, `entitlement.ts`, `audit-service.ts`,
  `secrets.ts`, `env.ts`, `http.ts`, `money.ts`, `format.ts`, `ids.ts`,
  `rate-limit.ts`, `validate.ts`, `billing/fulfil.ts`, `razorpay.ts`
  (deprecated signpost)
- `app/` — `login/`, `signup/`, `start/`, `pricing/`, `dashboard/` (overview,
  checker, reports, report detail, billing, invoice, return, settings),
  `admin/` (stats, users, user detail, plans, subscriptions, payment-gateways,
  logs), `error.tsx`, `not-found.tsx`
- `app/api/` — `auth/{signup,login,logout}`, `analysis`, `reports/[id]`,
  `checkout/{order,verify,cancel}`, `webhooks/[gateway]`, `webhooks/razorpay`,
  `account/{profile,password,sessions}`,
  `admin/{users/[id],plans/[id],gateways/[id]}`
- `components/` — `auth/`, `pricing/`, `dashboard/`, `report/`, `billing/`,
  `account/`, `admin/`, `sections/SiteHeader.tsx`, and additions to `ui/`
  (Field, Toast, Spinner, Skeleton, Badge, EmptyState, ProgressStages)
- root — `middleware.ts`, `scripts/verify.mjs`, `.env.example`

## 5. Files modified

Eight files, and only four of them touch the homepage surface:

| File | Change |
| --- | --- |
| `components/sections/Navbar.tsx` | three `href`s only: `#pricing` → `/pricing`, `#login` → `/login` (desktop and mobile) |
| `components/sections/Footer.tsx` | link targets only: relative anchors made absolute so they work off the homepage, and Pricing points at `/pricing` |
| `components/ui/UrlForm.tsx` | submit now hands off to `/start?url=…` instead of a fake 1.1 s timeout and a scroll; markup and styling unchanged |
| `components/sections/Features.tsx` | one `as const` on a data array, to satisfy `tsc --noEmit`; no visual change |
| `app/globals.css` | **purely additive** — 163 lines of app-shell, form, table and print styles appended in `@layer components`; not one existing line changed |
| `package.json` | added `typecheck` and `verify` scripts |
| `.gitignore` | ignore `data/` and `.env.local` |
| `README.md` | rewritten for the shipped system |

No section was removed or renamed, and `app/page.tsx` and
`components/illustrations/` are byte-for-byte unchanged.

## 6. Database schema changes

SQLite via `node:sqlite`, migrated forward in `lib/db/schema.ts` (versioned, so
an existing `data/app.db` upgrades in place without losing rows).

Tables created: `users`, `sessions`, `plans`, `subscriptions`, `payments`,
`invoices`, `websites`, `reports`, `report_issues`, `payment_gateways`,
`webhook_events`, `admin_logs`.

Altered in later migrations: `users` gained `role`, `status`, `blocked_at`,
`blocked_reason`, `last_active_at`; `subscriptions` renamed
`check_limit`/`checks_used` → `scan_limit`/`scans_used` and gained
`cycle_start`, `cycle_end`, `cycle_index`, `cycle_reset_at`, `features_json`,
`gateway`, `admin_note`; `payments` renamed the two Razorpay-specific id columns
to `gateway_order_id`/`gateway_payment_id` and gained `gateway`, `environment`,
`raw_status`; `reports` gained `features_json`, `pages_json`, `metrics_json`,
`checks_run`, `locked_json`; `report_issues` gained `feature`. Renames preserve
existing billing rows rather than recreating them.

## 7. Admin login setup

Set both variables and restart:

```bash
ADMIN_EMAIL=you@example.com
ADMIN_PASSWORD=a-strong-password
ADMIN_NAME=Administrator        # optional
```

On database open that account is created (or, if it already exists, has its role
raised to admin — a redeploy never resets a password an admin has changed). The
password is hashed with the same scrypt parameters as any other account and is
never stored in plain text. Sign in at `/login` as normal; the panel is at
`/admin`. Remove the two variables once the account exists.

There is no way to become an admin from the UI, and a normal user who types
`/admin` or posts to `/api/admin/...` gets the same refusal.

## 8. Payment gateway setup

Configure at `/admin/payment-gateways`. Each gateway has its own fields, an
environment switch (sandbox/live) and an enable toggle. Environment variables
seed the table for an env-only deployment; the table wins once a row exists.

- **Razorpay** — Key ID, Key Secret, Webhook Secret. Webhook endpoint
  `{APP_URL}/api/webhooks/razorpay`; subscribe to `payment.captured`,
  `order.paid`, `payment.failed`. Signature: HMAC-SHA256 hex over the raw body.
- **Cashfree** — App ID, Secret Key, Webhook Secret. Endpoint
  `{APP_URL}/api/webhooks/cashfree`; subscribe to `PAYMENT_SUCCESS_WEBHOOK`,
  `PAYMENT_FAILED_WEBHOOK`, `PAYMENT_USER_DROPPED_WEBHOOK`. Signature: base64
  HMAC-SHA256 over timestamp + raw body.
- **PayPal** — Client ID, Client Secret, Webhook ID, plus a settlement currency
  and the ₹-per-unit rate you maintain (PayPal will not settle INR for most
  accounts, and the app will not invent an exchange rate). Endpoint
  `{APP_URL}/api/webhooks/paypal`; subscribe to `PAYMENT.CAPTURE.COMPLETED`,
  `PAYMENT.CAPTURE.DENIED`, `PAYMENT.CAPTURE.REVERSED`,
  `CHECKOUT.ORDER.VOIDED`. Deliveries are verified by calling PayPal's
  verify-webhook-signature API.

Checkout offers only gateways that are configured **and** enabled. With all
three disabled, checkout refuses with a plain message rather than opening a dead
form. Secrets are never sent to the browser — not on the page, not in an API
response, not after saving.

## 9. Environment variables

`.env.example` documents each one with its default. The app runs with none of
them set.

| Variable | Purpose |
| --- | --- |
| `AUTH_SECRET` | signs session cookies; required in production, auto-generated in dev |
| `CREDENTIALS_SECRET` | AES-256-GCM key for stored gateway secrets; falls back to an HKDF derivation of `AUTH_SECRET` |
| `NEXT_PUBLIC_APP_URL` | callback URLs and invoice host |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `ADMIN_NAME` | bootstrap the first admin |
| `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET` | Razorpay seed credentials |
| `CASHFREE_APP_ID`, `CASHFREE_SECRET_KEY`, `CASHFREE_WEBHOOK_SECRET`, `CASHFREE_ENVIRONMENT` | Cashfree seed credentials |
| `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `PAYPAL_WEBHOOK_ID`, `PAYPAL_ENVIRONMENT` | PayPal seed credentials |
| `PAYMENTS_MODE=mock` | simulates checkout with no gateway account; refused in production |
| `DATA_DIR` | where `app.db` lives |
| `ANALYSIS_MAX_PAGES`, `ANALYSIS_TIMEOUT_MS`, `ANALYSIS_USER_AGENT` | crawler tuning |
| `ALLOW_PRIVATE_ANALYSIS_HOSTS` | dev-only; allows private address space. Ignored in production |
| `ANALYSIS_DEMO_FALLBACK` | dev-only; records a labelled demo report when a site truly cannot be reached. Ignored in production |

Every `process.env` read in the codebase is in `lib/env.ts` and nowhere else.
Only Razorpay's `KEY_ID` is exposed to the browser, because Checkout needs it.

## 10. What is fully functional now

Signup, login, logout, session expiry and multi-session management. The Free
plan granted on signup. Scanning with per-plan check gating, the monthly
allowance, the site limit, report history, report detail, and the ownership
boundary between accounts. Monthly cycle rolls and expiry. Upgrade prompts that
name the right plan and price. PDF export on Pro (print stylesheet). The whole
admin panel: stats, user block/unblock/delete/plan change/expiry/limits, plan
price and feature editing with reset-to-defaults, subscription and payment
history, gateway configuration with encryption and masking, and the audit log.
Checkout, verification, invoicing, duplicate-safe settlement and webhook
handling — end to end with `PAYMENTS_MODE=mock`, and with real keys for every
step that does not require the gateway to call back.

## 11. What needs external keys or services

Real money movement: Razorpay, Cashfree or PayPal credentials, and a publicly
reachable URL for webhook delivery. Live webhook signature verification for
PayPal additionally needs network access to PayPal's API at request time.

Not integrated, and not claimed anywhere in the UI: a plagiarism-database
provider (originality is measured against the site's own pages), a third-party
AI-detection service (the estimate is computed locally from stylometric
signals), and email — there is no transactional mail, so password reset is not
offered rather than being offered and silently failing.

## 12. Test results

```
npx tsc --noEmit          0 errors
node scripts/verify.mjs   353 passed, 0 failed
```

The suite compiles `lib/` to a temp directory and exercises the real modules
against a throwaway SQLite file — no mocks, no test framework, no network. It
covers: the catalogue (three monthly tiers, ₹0/₹399/₹999, 10/100/300, 1/3/8
sites, 13/35/44 checks, purchasability, feature membership); signup validation,
scrypt storage, duplicate accounts, sessions; the address filter's accept and
refuse lists including IPv6 mapped, NAT64 and 6to4 forms; that a refused target
costs no scan and writes no rows; the Free tier end to end; that a locked
feature produces no metric at all; the upgrade prompt; scan and site limits; the
monthly cycle roll and expiry; report ownership across accounts; checkout,
double settlement, forged payments, wrong currency, short amounts, unknown and
cancelled orders; what Basic unlocks and what it does not; feature add/remove
semantics; a Pro scan; signed Razorpay webhooks including redelivery, bad
signature, unsigned delivery, failed payment and an order that is not ours;
account suspension; re-pricing; the admin audit trail; account deletion with an
orphan sweep across seven tables; gateway credentials encrypted at rest and
masked on the way out; half-configured refusal; and the stale-run sweep's
credit-back.

`npm run build` was **not** run in this environment: it has no network access
and the installed `node_modules` are for a different platform, so `next build`
cannot execute here. `tsc --noEmit` covers the same type surface, but please run
`npm run build` yourself before deploying.

## 13. Known limitations

The homepage stat still reads “34 checks per scan” (`lib/checks.ts`). The engine
now runs up to 44, so the number understates the product — I left it alone
because the homepage is frozen. Change it when you want to; it is one integer in
static demo data.

Other limits worth knowing: the crawler samples six pages by default rather than
crawling a whole site, so large sites are judged on a sample; SQLite means one
writer, which is right for this scale but not for horizontal scaling; rate
limiting is in-process, so it resets on restart and is per-instance;
subscriptions do not auto-renew (no gateway subscription objects — a customer
buys another month), and there is no proration on upgrade; PayPal's exchange rate
is a figure you maintain by hand; and the AI and originality signals are
heuristics computed from the pages themselves, deliberately presented as
estimates.

Three cleanups need your hands, because this environment cannot delete files:

```bash
rm -f .git/*.lock          # two stale lock files block git
rm tsconfig.attest.json    # leftover from a temporary typecheck
rm lib/razorpay.ts         # deprecated signpost, nothing imports it
git add -A && git commit -m "Add accounts, plans, payments, admin and the analysis engine"
```
