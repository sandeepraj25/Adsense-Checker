# Verdict — AdSense Eligibility Checker

A pre-review AdSense audit tool: accounts, three monthly plans, three payment
gateways, an admin panel, a real website analyser, and stored reports, behind
the premium dark homepage at `/`.

## Run it

```bash
npm install
cp .env.example .env.local   # optional — see below
npm run dev                  # http://localhost:3000
```

Nothing needs configuring to start. On first request the app creates
`data/app.db` and, in development only, a random session secret at
`data/.dev-auth-secret`. Sign up, and the Free plan (10 scans a month) is
granted immediately, so the whole journey is walkable before any keys exist.

Also available: `npm run build`, `npm run typecheck`, `npm run verify`.

`npm run verify` is a dependency-free integration suite (353 assertions). It
compiles `lib/` to a temp directory and exercises the real modules against a
throwaway SQLite file: the plan catalogue, scrypt hashing and sessions, the
address filter's accept and refuse lists, monthly cycles and the allowance
reset, checkout and double settlement, forged and short-paid orders, signed
Razorpay webhooks including redelivery and bad signatures, gateway credentials
encrypted at rest and masked on the way out, feature gating in both directions,
the admin audit trail, account deletion with an orphan sweep, and the stale-run
sweep's credit-back. It needs no browser and no network.

Requires Node 22.5 or newer, because persistence uses the built-in
`node:sqlite` module.

## Stack

Next.js 15 (App Router) · React 19 · Tailwind CSS v4 (CSS-first `@theme`) ·
Framer Motion · lucide-react.

Nothing else. No ORM, no auth library, no payment SDK, no test runner:
`node:sqlite` for storage, `node:crypto` for scrypt password hashing, HMAC
signature verification and AES-256-GCM credential encryption, `fetch` for all
three gateway REST APIs, and `window.print()` with an `@media print` stylesheet
for report and invoice PDFs. Fewer dependencies is fewer things to keep
patched.

## Plans

Three plans, all billed monthly. There is no lifetime tier and no one-off
price anywhere in the product.

| Plan  | Price      | Scans / month | Websites | Checks / scan |
| ----- | ---------- | ------------- | -------- | ------------- |
| Free  | ₹0         | 10            | 1        | 13            |
| Basic | ₹399 / mo  | 100           | 3        | 35            |
| Pro   | ₹999 / mo  | 300           | 8        | 44            |

Free adds a basic page check and an HTTPS check. Basic adds the advanced page
check, AI content estimation, originality, duplicate content and the AdSense
policy check. Pro adds the deep per-page AI read, the AI + human-signal
content check, page-by-page scoring, site structure, crawlability, sitemap and
robots analysis, ad density, policy risk detection, prioritised
recommendations, priority support and PDF export.

`lib/plans.ts` holds the shipped defaults; the `plans` table is the live source
of truth and `lib/plan-catalogue.ts` is the only way to read or write it. An
admin can change a price, an allowance or a feature set at `/admin/plans`, and
every surface — pricing page, checkout, dashboard, engine — reads the new
value, because no price or limit is hardcoded anywhere else. Prices are
integers in paise; no float ever touches an amount.

Allowances are monthly, not lifetime. Each subscription carries a cycle window
and a `scans_used` counter; the cycle rolls on read (there is no scheduler in a
Next.js app, and a cron job nobody installed is indistinguishable from a bug
where nobody's quota ever refills), resetting usage and re-reading the plan's
current limit. A changed limit therefore lands at renewal, which is when the
terms are up for renegotiation anyway.

Every plan feature is enforced server-side. The pricing page renders what the
catalogue says, the engine runs only the checks the account's feature set
includes, and the API routes re-check entitlement on every call — calling
`/api/analysis` by hand does not get anyone a Pro check or an eleventh free
scan. The scan claim is a single `UPDATE … WHERE scans_used < scan_limit`, so
two concurrent requests cannot both take the last one.

## Money

A purchase is: create an order server-side at the price the catalogue says
(never a price from the request body) → hand off to the gateway → the gateway
returns → verify the signature server-side → re-fetch the payment from the
gateway and confirm the amount and currency match the order → grant the plan
and issue an invoice, all in one transaction.

A browser claiming success proves nothing; only that server-side chain grants
anything. `lib/billing/fulfil.ts` is the only code that can grant a plan, and
fulfilment is keyed on the order, so a duplicate callback — a retried webhook,
a double-clicked redirect, both racing at once — returns the subscription that
already exists instead of creating a second one. Webhook deliveries are keyed
on the gateway's event id for the same reason. Anything that cannot be
verified is refused and recorded for the admin panel rather than acted on.

Three gateways sit behind one `Gateway` contract in `lib/payments/`:
**Razorpay** (INR, HMAC-SHA256 webhook signatures), **Cashfree** (INR, base64
HMAC over timestamp + raw body) and **PayPal** (settles in a convertible
currency at a rate the admin maintains, deliveries verified by calling
PayPal's own verify-webhook-signature endpoint). Checkout offers only the
gateways an admin has configured and enabled; if all three are off, checkout
refuses with a plain message instead of opening a dead form.

### Checkout page

A paid plan's button on `/pricing` links to `/checkout?plan=<id>`. A visitor
who is not signed in is sent to log in (or sign up) with that URL as `next`,
so they land back on the same plan. The page loads the plan's name, price,
interval and limits from the catalogue on the server, refuses unknown,
inactive, free or non-purchasable plans, and lists only gateways that are
configured *and* enabled (none listed → "checkout is temporarily
unavailable", with no Pay button).

The form collects a legal name, a billing email (prefilled with the login
email, editable) and a phone number with a country code, validated with
`libphonenumber-js` and stored in E.164 form. The same rules run in the
browser and in `POST /api/checkout/order`; the server's answer is the one
that counts. No card, UPI or bank details are ever collected here.

Each purchase attempt carries a random id stored on the payment row under a
UNIQUE `(user_id, idempotency_key)` index: a double submit, a retried request
or a race maps to the same order, while a cancelled or failed attempt cannot
be revived — the form draws a new id for the retry. Billing details are
saved on the payment and printed on the invoice. Purchases are one-time
payments for 30 days; nothing renews or charges automatically, and the page
says so. After the gateway returns, `/checkout/success` shows the order's
state as the server recorded it.

Credentials live in the `payment_gateways` table. Secrets are encrypted at
rest with AES-256-GCM under a key from `CREDENTIALS_SECRET`, are never
returned by any API, and come back to the admin panel masked to their last
four characters (`••••••••••••1234`). Saving a field empty keeps the stored
secret rather than clearing it, and a gateway cannot be switched on until it
is completely configured — the refusal names the missing fields.

## Accounts and sign-in

One login page, `/login`, for everyone. The form has no role field: after the
password checks out, the server reads the account's role from the database and
answers with where to go — administrators to `/admin`, customers to
`/dashboard`, or the page they originally asked for when they are allowed to
see it (`?next=`, sanitised; a customer asking for `/admin` gets the
dashboard). Opening `/admin` logged out redirects to `/login?next=/admin`.
"Keep me signed in" (ticked by default, matching the old behaviour) gives a
30-day cookie; unticked, the cookie ends with the browser and the server
session lasts at most a day of inactivity.

Sign-up confirms the email address before the account exists:

1. `POST /api/auth/signup` validates the form and writes a
   `pending_registrations` row (name, scrypt password hash, HMAC of a random
   6-digit code bound to the address) plus an httpOnly `aec_verify` cookie
   tying the flow to this browser. The code is emailed; it is never stored,
   logged or returned. No user row, no session.
2. `/verify-email` shows the masked address, a countdown and a resend control.
   `POST /api/auth/verify-email` checks the code in constant time inside one
   transaction that deletes the pending row and creates the user (role
   `user`, `email_verified_at` set) and the free plan — so two racing requests
   cannot both succeed. Only then is a session started.
3. `POST /api/auth/resend-verification` issues a new code; the old one stops
   working at once.

Limits: a code lives 10 minutes and survives 5 wrong tries, then must be
replaced; a pending sign-up lives 24 hours; resends have a 60-second cooldown
and an hourly cap of 5 per address and 20 per IP; sign-ups are capped at 5 per
address and 10 per IP per hour; verify attempts at 30 per IP per 15 minutes.
Signing up with an address that already has an account returns the same
response as a new address and emails the owner "you already have an account"
instead of a code — sign-up cannot be used to find out who is registered, and
nothing about the existing account changes. Logging in with the right password
for a sign-up that was never confirmed sends a fresh code and returns to
`/verify-email`.

Accounts that existed before email verification keep `email_verified_at`
NULL, meaning "not recorded" — they were created under the old flow or by
`ADMIN_EMAIL` and stay fully usable. Since a `users` row is only created after
confirmation, there is no "unverified account" state for any guard to miss.

There is no password-reset flow yet. Building one needs its own single-use
reset tokens (not the sign-up codes) and the same email provider.

## Live chat

A floating chat button sits bottom-right on public and customer pages (not on
admin, checkout or invoice pages). Visitors can write without an account;
signed-in users' chats belong to their account on every device.

- **Ownership.** A guest's first message creates their conversation and an
  httpOnly `aec_chat` cookie holding a random token; only its HMAC is stored.
  Customer endpoints never accept a conversation id — the server finds the
  thread from the session or that cookie. Signing in folds a guest thread into
  the account's, and clears the cookie.
- **Live delivery.** `/api/chat/stream` and `/api/admin/chats/stream` are
  Server-Sent-Events streams fed by an in-process notifier. Events carry ids
  only; browsers then re-read through the checked REST endpoints. This suits
  the single-server deployment (one `next start`, SQLite on a persistent disk).
  Running several instances would need the notifier moved to Redis pub/sub.
- **Presence.** Support shows as online while a linked, available member has
  Admin → Live chat open (the stream heartbeat). "Away" shows as offline. No
  response time is promised.
- **Inbox** (`/admin/chats`): conversations with unread counts, filters (all,
  unread, open, assigned to me, resolved), search, reply, assign, resolve /
  reopen, customer and account details. The first member to reply is
  assigned. A customer message reopens a resolved chat.
- **Support team** (`/admin/support-team`): the names and roles customers see
  (seeded once with Sandeep — Admin and Gungun — Member, unlinked). Link each
  member to an administrator login so they can reply; the displayed role is a
  label, not a permission. Members who have replied can be deactivated but not
  deleted, so past conversations keep their name.
- **Limits.** Plain text up to 2,000 characters; 20 messages a minute per
  customer, 30 per IP, 5 new guest chats an hour per IP. Each message carries a
  client id so a double send is stored once.

## Payment & checkout alerts

Admin → Notifications (`/admin/settings/notifications`) holds the **Payment &
Checkout Alert Email**, the abandonment wait (default 30 minutes), the alert
history with Retry, and recent checkout records. With no address set, alerts are
off and the page says so; nothing is recorded as sent unless the email provider
accepted it.

- **Payment failed** is sent only when the provider reports the payment as
  failed: Razorpay's payment status `failed` or a signed `payment.failed`
  webhook, Cashfree's own order status, a PayPal decline. A pending payment, a
  closed payment window, a lost connection or our own signature refusal never
  raises one.
- **Abandoned checkout.** Once a signed-in customer's billing details on
  `/checkout` are complete and valid, the form saves them (debounced) to
  `POST /api/checkout/progress`, a `checkout_sessions` record priced from the
  catalogue. Pressing Pay marks it `payment_started`; settling marks it `paid`.
  A record still `in_progress` after the wait — with no order or matching plan
  since — is claimed as `abandoned` by one guarded UPDATE and alerted once.
- **Delivery.** Alerts go through the existing email provider (Resend). Each event
  has a unique key in `notifications`, so it is alerted once, and every send is
  claimed atomically first. Temporary failures (429, 5xx, network) retry after 1,
  5 and 30 minutes, then 2 and 6 hours, up to 5 attempts. Rejections (bad key,
  unverified sender) stop at once and can be retried from the page.
- **Scheduling.** Create a Render **Cron Job** (or any scheduler) that runs every
  5 minutes:

      curl -fsS -X POST -H "Authorization: Bearer $CRON_SECRET" \
           https://YOUR-SITE/api/internal/jobs/checkout-alerts

  with the same `CRON_SECRET` set on the web service and the cron job. The web
  service also runs the job every 5 minutes on its own as a safety net
  (`instrumentation-node.ts`; `CHECKOUT_ALERTS_BACKGROUND=off` disables it).
  Running both is safe.
- **Retention.** Checkout records that never led to a payment are deleted after 30
  days; alert bodies (which name the customer) are cleared after 90.

## Website analytics

Admin → **Website analytics** (`/admin/analytics`) reports in one place:

- **From existing records** (covers history): sign-ups, verified accounts, active accounts, scans and their outcomes, revenue per currency, payment success, checkout abandonment, webhook and alert-email health.
- **From first-party tracking** (only from the day it went live): visitors, visits, page views, landing/exit pages, referrers, UTM campaigns, devices, the visitor-journey funnel. Earlier days are labelled as not tracked, never estimated.

Tracking is the site's own: `components/analytics/Tracker.tsx` posts to `/api/analytics/collect`, which accepts only `page_view`, `pricing_viewed`, `plan_selected` and `checkout_started` in a strict schema. Accounts, payments and scans are recorded by the server (`lib/analytics/store.ts → trackServerEvent`), keyed so a retry or a repeated webhook is stored once. No third-party script, no cookie. Paths are stored without query strings and with ids collapsed; IP addresses are never stored (visitors are a daily-salted hash). Bots, admin pages, signed-in admins and listed internal IPs are excluded. Browsers sending Do Not Track / Global Privacy Control send nothing.

Settings (`/admin/analytics/settings`): tracking on/off, reporting timezone, default range, internal traffic, retention (default 395 days), privacy mode (cookie-free, or a banner asking to remember the browser), CSV export permission and whether account exports include emails.

Retention clean-up runs inside the existing alerts job (the Render Cron Job calling `/api/internal/jobs/checkout-alerts`) and on new visits, at most every six hours — no extra service is needed. Optional: behind Cloudflare, set `ANALYTICS_COUNTRY_HEADER=cf-ipcountry` to record visitor countries.

Tests: `npm run test:analytics`.

## Admin

Set `ADMIN_EMAIL` and `ADMIN_PASSWORD`, restart, and that account is raised to
admin on database open; sign in normally and go to `/admin`. If the account
already exists only its role changes, so a redeploy never resets a password an
admin changed. Remove the variables once the account exists.

`/admin` covers revenue and usage stats, users (`/admin/users` — block,
unblock, delete, change plan, set expiry, adjust limits), plans
(`/admin/plans` — price, allowances, feature sets, reset to shipped defaults),
subscriptions and payment history (`/admin/subscriptions`), gateway
configuration (`/admin/payment-gateways`) and the audit log (`/admin/logs`).

Authorisation is checked in the page, in the API route, and in the database
read — not by hiding a link. A normal user who types `/admin` or posts to
`/api/admin/users/:id` gets the same refusal. Every consequential change
(block, unblock, delete, plan change, subscription change, price change,
gateway enable or disable, credentials updated) is written to the audit log
with the admin who made it and what changed; log entries deliberately outlive
the accounts they describe. Deleting a user removes their sessions,
subscriptions, payments, invoices, websites, reports and findings in one
transaction, so nothing is orphaned.

Blocking an account deletes its sessions, refuses its logins, stops new scans
and paid features, and replaces the dashboard body with the reason in plain
language. Nothing is deleted — reports and billing history are intact when the
suspension is lifted.

## Analysis

`lib/analysis/` fetches the site, follows a small number of internal links,
and runs up to 44 checks across six categories: Content Quality, SEO,
Navigation, Mobile Experience, Privacy & Legal, and Technical Health. Findings
are weighted into a 0–100 score and a Ready / Needs Improvement / Not Ready
verdict, then persisted with the individual issues so an old report reads
exactly as it did the day it ran. Only the categories that actually ran are
scored, and their weights are rebased to sum to 100 — a Free report is a real
report over fewer dimensions, not a Pro report with holes in it.

A check outside the account's feature set is not run at all: not run and shown
as locked, not run and shown as failing. The report simply does not contain
it, and names the features that would have added more. Computing a Pro-only
signal for a Free account and then hiding the answer would be both a waste and
a lie of omission about what the tier includes.

Outbound requests resolve the host first and refuse private, loopback,
link-local, carrier-grade NAT and cloud-metadata address space, in IPv4 and
IPv6 including mapped, NAT64 and 6to4 forms — that is what keeps the analyser
from being used as an SSRF proxy. Public domains, bare domains, `www.` forms
and both schemes all work; a refusal is reported as a refusal and a dead
domain as a dead domain. Neither costs the customer a scan: the address filter
and the reachability probe both run before the allowance is claimed, and a run
that dies mid-flight is closed by a sweep that credits the scan back.

On honesty: AI detection is reported as an estimate with a confidence band and
is never presented as a verdict; originality is a signal computed from the
site's own pages, not a plagiarism-database result, and says so; nothing in
the product claims Google will approve a site. A report produced from seeded
data (when a site cannot be reached) is labelled demo data everywhere it
appears. Claiming a mock result was a real approval check would make the whole
product worthless.

## Routes

Public: `/`, `/pricing`, `/login`, `/signup`, `/verify-email`, `/start`. Chat: `/api/chat`, `/api/chat/messages`, `/api/chat/contact`, `/api/chat/stream`.

Authenticated: `/checkout?plan=<id>`, `/checkout/success?order=<id>`,
`/dashboard`, `/dashboard/checker`, `/dashboard/reports`,
`/dashboard/reports/[id]`, `/dashboard/billing`, `/dashboard/billing/return`,
`/dashboard/billing/invoices/[id]`, `/dashboard/settings`.

Admin: `/admin`, `/admin/users`, `/admin/users/[id]`, `/admin/plans`,
`/admin/subscriptions`, `/admin/payment-gateways`, `/admin/logs`,
`/admin/account`, `/admin/pricing`, `/admin/chats`, `/admin/support-team`.

Webhooks: `/api/webhooks/[gateway]` for all three, plus
`/api/webhooks/razorpay` kept as a one-line delegation so deployments that
already registered that URL do not have to re-register it.

`/start` is the handoff for a URL typed on the homepage by someone not signed
in: it holds the domain through signup and plan selection so the URL survives
the detour. Middleware bounces unauthenticated requests off `/dashboard/*`,
`/admin/*` and `/checkout` with a `next` parameter; each page also checks the session itself,
since middleware alone is not an authorisation boundary.

## Environment

`.env.example` documents every variable with its default. In short:
`AUTH_SECRET` is required in production and optional in development;
`CREDENTIALS_SECRET` encrypts stored gateway secrets and falls back to a key
derived from `AUTH_SECRET` under a separate HKDF label; `NEXT_PUBLIC_APP_URL`
builds callback URLs and invoice hosts; `ADMIN_EMAIL` and `ADMIN_PASSWORD`
bootstrap the first admin; the `RAZORPAY_*`, `CASHFREE_*` and `PAYPAL_*`
variables seed the gateway table for an env-only deployment;
`PAYMENTS_MODE=mock` simulates a purchase end to end with no gateway account
and is refused in production; `DATA_DIR` relocates the database; `AVATAR_DIR`
(optional, default `<DATA_DIR>/avatars`) relocates profile photos; and the
`ANALYSIS_*` variables plus `ALLOW_PRIVATE_ANALYSIS_HOSTS` tune the crawler. `EMAIL_PROVIDER`, `RESEND_API_KEY`
and `EMAIL_FROM` send sign-up verification codes through Resend — without them
production refuses new sign-ups (see "Accounts and sign-in").

### Profile photos and persistent storage

Profile photos are decoded, cropped to 256×256 and re-encoded as WebP by
`sharp` (EXIF and GPS data are dropped), then written to `AVATAR_DIR` under a
random 24-character name. The database stores only that name. Photos are
served by `/api/avatars/[key]` to their owner and to admins only.

On Render (or any host with an ephemeral filesystem) mount a **persistent
disk** and point `DATA_DIR` at it — for example a disk mounted at
`/var/data` with `DATA_DIR=/var/data`. That disk already has to hold the
SQLite database; photos live beside it, so they survive restarts and
redeploys for the same reason accounts do. Without a persistent disk, both
the database and the photos are lost on every deploy. No cloud storage
credentials are needed.

Every read of `process.env` in the codebase lives in `lib/env.ts` and nowhere
else, so what reaches the browser is auditable in one file. Razorpay's
`KEY_ID` is sent to the client on purpose — Checkout needs it. Every secret and
webhook secret is server-only and is never returned by any route.

## Design system

Tokens live in `app/globals.css`. Nothing is hard-coded in components — if a
colour or type treatment needs to change, it changes there.

**Colour.** `ink-950 → ink-700` for surfaces (deep blue-black, never pure
black). Brand gradient runs `azure-500 → iris-500 → orchid-500`. Semantic
colour is reserved strictly for verdicts: `mint-400` pass, `amber-400` fix,
`rose-400` blocker. Keeping the brand gradient off status states is what
makes a verdict readable at a glance.

**Type.** Bricolage Grotesque for display (tight tracking, large sizes),
Inter Tight for body, JetBrains Mono for data — URLs, scores, and category
codes are technical artifacts, so they get the utility face. Helpers:
`.t-display`, `.t-h1/.t-h2/.t-h3`, `.t-eyebrow`, `.t-body`, `.t-data`.

**Layering.** Custom classes are wrapped in `@layer components` so plain
utilities (`hover:border-*`, `text-*`) still override them. Unlayered CSS
beats every Tailwind layer, which silently kills hover states — worth
preserving if you add classes.

## Signature element

The hero card is the product's own output running itself: a sweep crosses the
panel, checks land one at a time, and the dial settles on **72** with three
blockers. Showing an imperfect score is deliberate — the interesting question
for a visitor is what their own number would be, and a flawless green
dashboard doesn't provoke it.

The same gesture returns in the report preview when you hit **Re-run**.

## Structure

```
app/
  page.tsx            the homepage — finalized, do not redesign
  globals.css         design tokens, primitives, keyframes
  pricing/ login/ signup/ start/
  dashboard/          overview, checker, reports, billing, settings
  admin/              stats, users, plans, subscriptions, gateways, logs
  api/                auth, checkout, webhooks, analysis, reports,
                      account, admin
components/
  ui/                 Container, Button, GlassCard, ScoreArc, UrlForm, Toast,
                      Field, Skeleton, Badge, EmptyState, ProgressStages
  illustrations/      Logomark, Aurora, GridPlane, AuditCard, glyphs
  sections/           Navbar, Hero, TrustBar, Stats, Process, Features,
                      ReportPreview, FinalCta, Footer
  auth/ pricing/ dashboard/ report/ billing/ account/ admin/
lib/
  plans.ts            shipped plan defaults and the feature catalogue
  plan-catalogue.ts   the live plans table — the source of truth
  entitlement.ts      what an account may do, and why not
  secrets.ts          AES-256-GCM for stored gateway credentials
  env.ts              every process.env read in the codebase
  db/                 schema, migrations, repositories, admin log
  auth/               scrypt, session cookies, route guards
  payments/           the Gateway contract, Razorpay, Cashfree, PayPal
  billing/fulfil.ts   the only code that grants a plan
  analysis/           fetcher, HTML reader, 44 checks, scoring
  audit-service.ts    validate → authorise → consume → run → store
scripts/verify.mjs    npm run verify
middleware.ts         edge-safe dashboard and admin gate
```

## Interaction notes

`prefers-reduced-motion` is honoured throughout: the sweep is removed and
every reveal, count-up, and arc animation resolves instantly. Keyboard focus
is visible on every control. Forms validate on submit with inline messages,
lists have skeleton and empty states, and every failure the flow can produce —
invalid URL, refused address, DNS failure, dead site, scan failure, no plan,
expired plan, monthly limit reached, site limit reached, locked feature,
payment failure, unverifiable webhook, unauthorized access, suspended account,
disabled gateway, server error — has its own worded message rather than a
generic one. Server errors are logged server-side and answered with a generic
message; no stack trace or database detail reaches the browser.

## Illustrations

All SVG is hand-drawn in `components/illustrations/`. The platform glyphs in
the trust row are original geometric marks, not reproductions of anyone's
trademark — the wordmark beside each does the naming.
