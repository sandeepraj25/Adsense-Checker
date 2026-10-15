# Verdict — AdSense Eligibility Checker

A pre-review AdSense audit tool: accounts, three monthly plans, three payment
gateways, an admin panel, a real website analyser, and stored reports, behind
the premium dark homepage at `/`.

## Run it

Deploying to your own server (e.g. an Oracle Cloud Always Free VM with your
domain and HTTPS): see [deploy/oracle/README.md](deploy/oracle/README.md).

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

`npm run test:all` runs the whole regression in one go — type check, lint,
production build and every suite below — and ends with a table of passed,
failed and blocked suites (blocked names the missing prerequisite: the report suite needs a Chrome or
Chromium). The test servers never pick up your `.env.local`: every variable
it defines is blanked unless the test sets it (`scripts/lib/server-env.mjs`),
so your real SMTP account and site URL are not used by tests. Each suite also runs on its own (`npm run test:<name>`).

`npm run verify` is a dependency-free integration suite (396 assertions). It
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

| Plan  | Price      | Scans / month | Pages / scan | Websites | Checks / scan |
| ----- | ---------- | ------------- | ------------ | -------- | ------------- |
| Free  | ₹0         | 10            | 1            | 1        | 13            |
| Basic | ₹399 / mo  | 100           | 25           | 3        | 35            |
| Pro   | ₹999 / mo  | 300           | 200          | 8        | 44            |

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

Links inside emails (the "Log in" button in the already-registered notice) use
`NEXT_PUBLIC_APP_URL` when it is set, never the request's Host header, so a
forged request cannot make a real email point somewhere else.

## Email (Google SMTP)

Verification codes and payment alerts are sent through Google's SMTP server
with [Nodemailer](https://nodemailer.com). A code counts as sent only when the
SMTP server accepts the recipient; on any failure the code is destroyed, no
account is created, the visitor is told to try again, and the server log says
why (never with the password or the code).

### Set up the Google account

1. Use a Gmail or Google Workspace account for sending — ideally a dedicated
   one such as `no-reply.yourbrand@gmail.com`.
2. Turn on **2-Step Verification**: Google Account → Security → 2-Step
   Verification. App Passwords need it.
3. Create an **App Password**: Google Account → Security → App passwords (or
   <https://myaccount.google.com/apppasswords>). Name it "AdSense Checker",
   copy the 16-letter password. On Workspace the administrator must allow it;
   if the option is missing, see "Larger volumes" below.
4. Never use the account's normal password. The app refuses a value for
   `smtp.gmail.com` that isn't 16 letters.

### Configure

Local (`.env.local`, never committed):

```env
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=your-verification-email@gmail.com
SMTP_APP_PASSWORD=abcd efgh ijkl mnop
EMAIL_FROM=AdSense Checker <your-verification-email@gmail.com>
NEXT_PUBLIC_APP_URL=http://localhost:3000
```

Render: Dashboard → your web service → **Environment** → add the same keys,
with `NEXT_PUBLIC_APP_URL=https://yourdomain.com` (your real HTTPS address),
then **Save, rebuild and deploy** — `NEXT_PUBLIC_` values are read at build
time. Remove `EMAIL_PROVIDER=console` / Resend keys if you set them before (or
set `EMAIL_PROVIDER=smtp` explicitly).

**Render's free web services block outbound SMTP (ports 25, 465 and 587)**, so
Gmail SMTP needs a paid instance there. On a free instance every send fails
with "Could not reach the SMTP server".

`EMAIL_FROM` must be `SMTP_USER` itself or a "Send mail as" alias verified in
Gmail settings; otherwise Gmail replaces it with `SMTP_USER`. Port 587 always
upgrades to TLS with STARTTLS — the app refuses to send the password to a
server that doesn't offer it — and 465 uses TLS from the start.

### Test delivery

1. Admin → Notifications: the status line reads "Delivered through Google
   SMTP (smtp.gmail.com:587)", or shows exactly which variable is wrong.
2. Save an alert email there and press **Send a test email** — it reports what
   Google answered.
3. Sign up with an address you can read; the code should arrive within a
   minute (check Spam the first time).

### When it fails

The server log line starting `[email]` names the cause:

| Log says | Fix |
|---|---|
| `SMTP sign-in was refused (EAUTH 535 …)` | Wrong `SMTP_USER`, App Password revoked or mistyped, or 2-Step Verification turned off. Create a new App Password. |
| `secure connection … failed` | Port and TLS mismatch: 587 + `SMTP_SECURE=false`, or 465 + `SMTP_SECURE=true`. |
| `Could not reach the SMTP server` | Network: wrong host/port, or the host blocks SMTP (Render free tier). |
| `refused the sender or recipient (550 …)` | `EMAIL_FROM` isn't the account or a verified alias, or the recipient address doesn't exist. |
| `daily sending limit (550 5.4.5)` | Gmail's quota is used up; it resets within 24 hours. |
| `SMTP_APP_PASSWORD is not set` / `doesn't look like a Google App Password` | Set the 16-letter App Password. Sign-ups are paused until then. |

### Larger volumes

A free Gmail account can send to about 500 recipients a day, and a Google
Workspace user 2,000 messages a day, over a rolling 24 hours — then Gmail
refuses mail until the window passes, and sign-ups fail meanwhile. For more,
use Workspace's SMTP relay (`smtp-relay.gmail.com`) or a transactional
provider; Resend is still supported (`EMAIL_PROVIDER=resend`).

### Tests

`node scripts/smtp-test.mjs` (after `npm run build`) runs the whole flow against
a local SMTP server that the real Nodemailer transport connects to: code
delivery and sign-in with the App Password, hashed storage, wrong / expired /
reused / locked codes, resend cooldown, a refused App Password, a rejected
recipient, temporary failures, the Gmail quota, the already-registered notice
with a forged Host header, alerts, configuration errors, and refusal to log in
without STARTTLS. It does not reach `smtp.gmail.com` itself.

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
- **Delivery.** Alerts go through the same email provider (Google SMTP; see "Email (Google SMTP)"). Each event
  has a unique key in `notifications`, so it is alerted once, and every send is
  claimed atomically first. Temporary failures (429, 5xx, network) retry after 1,
  5 and 30 minutes, then 2 and 6 hours, up to 5 attempts. Rejections (bad key,
  unverified sender) stop at once and can be retried from the page.
- **Scheduling.** See [Scheduled jobs](#scheduled-jobs): a scheduler calls
  `POST /api/internal/jobs/checkout-alerts` every 5–10 minutes. The web
  service also runs the job every 5 minutes on its own while it is awake, as a
  safety net (`CHECKOUT_ALERTS_BACKGROUND=off` disables it). Running both is
  safe.
- **Retention.** Checkout records that never led to a payment are deleted after 30
  days; alert bodies (which name the customer) are cleared after 90.

## Scheduled jobs

Three jobs run on a schedule. Each has its own endpoint, its own work and its
own records; they share only the gate (`lib/scheduler.ts`): one `CRON_SECRET`,
compared in constant time, with a separate rate limit per job.

| Job | Endpoint (POST) | What it does | Emails go to |
| --- | --- | --- | --- |
| Payment & checkout alerts | `/api/internal/jobs/checkout-alerts` | marks abandoned checkouts, sends and retries alerts, retention clean-up | the admin's alert address |
| Prediction feedback | `/api/internal/jobs/ml` | accepts deferred answers, sends the 14-day "did AdSense approve?" email, trains nightly | customers |
| Weekly rescans (Pro) | `/api/internal/jobs/rescans` | runs due rescans, sends change emails | customers |

Responses: `503` when `CRON_SECRET` is missing or under 32 characters (the
endpoints are then shut), `401` without the right `Authorization: Bearer`
token, `429` after 30 calls a minute from one address, `405` for GET, `200`
with a summary when the job ran. Every job is safe to call more often than
needed and from several places at once — every claim is a guarded database
update.

**Environment variables (web service):**

| Variable | Required | Meaning |
| --- | --- | --- |
| `CRON_SECRET` | yes, for scheduling | 32+ random characters, e.g. `openssl rand -hex 32`. Same value on the scheduler. |
| `NEXT_PUBLIC_APP_URL` | yes | The public site address; links in emails use it. |
| `SMTP_*`, `EMAIL_FROM` | yes, for any email | See "Email (Google SMTP)". |
| `CHECKOUT_ALERTS_BACKGROUND`, `ML_BACKGROUND`, `RESCANS_BACKGROUND` | no | `off` disables the server's own 5-minute check for that job. |
| `ML_TRAIN_HOUR_UTC` | no | Hour of the nightly training (default 21 = 02:30 IST). |

**The scheduler** runs `scripts/run-scheduled-jobs.mjs` (or `npm run jobs:run`),
which calls the endpoints and exits non-zero if any call fails. It needs only
Node 22 and two variables: `APP_URL` (the site address) and `CRON_SECRET`.
Pass job names to call only some (`node scripts/run-scheduled-jobs.mjs
checkout-alerts`).

On Render, create a **Cron Job** service from the same repository:

1. New → Cron Job → this repository and branch.
2. Schedule: `*/10 * * * *` (every 10 minutes; `*/5` is also fine).
3. Build command: `node --version` (the script needs no packages).
4. Command: `node scripts/run-scheduled-jobs.mjs`
5. Environment: `APP_URL=https://your-domain` and the same `CRON_SECRET` as the web service.
6. Deploy, then use **Trigger Run** once and read its log: three `ok` lines.

Any other scheduler works the same way — for example cron-job.org or a GitHub
Actions scheduled workflow — as long as it sends
`POST` with `Authorization: Bearer <CRON_SECRET>` to each endpoint.

**Checking it is really running.** Admin → Settings → Notifications →
*Scheduled jobs* lists each job with the time and result of the last call made
with the secret. It says *Verified* only after a real scheduler call in the
last 30 minutes; the server's own background check and the *Run now* button
never count. *Not verified — never called* means no scheduler has reached
this server yet.

**Hosting notes (Render):**

- The in-process 5-minute check only runs while the web service is awake. Free
  instances sleep after a period without traffic, so without an outside
  scheduler abandoned checkouts may go unchecked for hours. The scheduler's
  request also wakes the service.
- Render's free web services block outbound SMTP, so on a free instance no
  email (alerts, codes, feedback) can be sent, whatever the schedule. Use a
  paid instance, or an email API provider.
- The database must be on a persistent disk (`DATA_DIR`), or every deploy
  forgets checkouts, alerts and the scheduler record.

Tests: `npm run test:scheduler` (builds first) — the gate, the record of
scheduler calls, the admin status and the client script, over HTTP.

## Website analytics

Admin → **Website analytics** (`/admin/analytics`) reports in one place:

- **From existing records** (covers history): sign-ups, verified accounts, active accounts, scans and their outcomes, revenue per currency, payment success, checkout abandonment, webhook and alert-email health.
- **From first-party tracking** (only from the day it went live): visitors, visits, page views, landing/exit pages, referrers, UTM campaigns, devices, the visitor-journey funnel. Earlier days are labelled as not tracked, never estimated.

Tracking is the site's own: `components/analytics/Tracker.tsx` posts to `/api/analytics/collect`, which accepts only `page_view`, `pricing_viewed`, `plan_selected` and `checkout_started` in a strict schema. Accounts, payments and scans are recorded by the server (`lib/analytics/store.ts → trackServerEvent`), keyed so a retry or a repeated webhook is stored once. No third-party script, no cookie. Paths are stored without query strings and with ids collapsed; IP addresses are never stored (visitors are a daily-salted hash). Bots, admin pages, signed-in admins and listed internal IPs are excluded. Browsers sending Do Not Track / Global Privacy Control send nothing.

Settings (`/admin/analytics/settings`): tracking on/off, reporting timezone, default range, internal traffic, retention (default 395 days), privacy mode (cookie-free, or a banner asking to remember the browser), CSV export permission and whether account exports include emails.

Retention clean-up runs inside the existing alerts job (the scheduler calling `/api/internal/jobs/checkout-alerts`, see [Scheduled jobs](#scheduled-jobs)) and on new visits, at most every six hours — no extra service is needed. Optional: behind Cloudflare, set `ANALYTICS_COUNTRY_HEADER=cf-ipcountry` to record visitor countries.

Tests: `npm run test:analytics`.

## Approval prediction model

Admin → **Prediction model** (`/admin/ml`). Everything runs locally in `lib/ml/` — no outside AI service.

- **Data.** Every completed live scan stores its numeric feature vector in `scan_features` (schema `fs-1`; scores, check results, metrics, analyzer signals — never page text). One row per report, so retries add nothing. Demo reports are not stored.
- **Feedback.** 14 days after a scan the dashboard asks "Did AdSense approve your site?" (Approved / Rejected + optional reason / Not applied yet), and one email is sent through the normal mailer. Every answer is kept in `ml_feedback` with what was done with it. Rules: answers from accounts under 3 days old are deferred; one answer per site and scan, correctable once within 7 days; opposite answers for a site from different accounts within 30 days count half; an account with more than 20 answers in 30 days is scaled down.
- **Estimates.** Below 200 usable labels (and 30 of each outcome) the estimate is a published rule-based index labelled "Estimated (rule-based)". After that, nightly training fits logistic regression (and softmax for rejection reasons when there is enough data), validates on sites it never trained on, and promotes the candidate only if it passes the acceptance criteria shown on the admin page. Earlier active models can be restored there.
- **Scheduling.** Called by the same scheduler (see [Scheduled jobs](#scheduled-jobs)):
  `POST /api/internal/jobs/ml`. It sends due feedback emails and trains once a night (`ML_TRAIN_HOUR_UTC`, default 21 = 02:30 IST). The server also runs it every 5 minutes as a safety net (`ML_BACKGROUND=off` disables that). One training run at a time is enforced in the database.

Tests: `npm run test:ml` (maths, rules, database) and `npm run test:ml-http` (pages and APIs, builds first).

## Monthly and yearly billing

Admin → **Pricing** sets, per plan, a yearly price in INR and USD (twelve months, paid once), a per-plan yearly switch and an optional badge ("2 months free"); a site-wide **Enable yearly billing** switch on the same page turns the Monthly / Yearly toggle on for the pricing page, homepage and billing page. The discount shown is `floor((1 − yearly ÷ (monthly × 12)) × 100)`. Prices are in the website currency; nothing is converted.

Checkout sends the chosen cycle; the server reads the price for that plan, currency and cycle and ignores any amount from the browser. Purchases from this version on run for calendar months (counted in IST from the purchase date — 31 Jan → 28/29 Feb → 31 Mar); yearly plans run twelve calendar months and still reset the scan allowance every month. Subscriptions bought before keep their 30-day cycles. Plans don't renew automatically, so "Switch to yearly at renewal" on the billing page records the choice and makes it the default when the customer renews — nothing is charged early.

Tests: `npm run test:billing-cycle` (builds first).

## Usage limits

Each plan has two limits, edited at Admin → **Plans** with no redeploy:
**scans per month** (`scan_limit`) and **pages per scan** (`pages_per_scan`,
1–500: content pages read per scan, homepage included; the privacy, about,
contact and terms pages are read on top). The upgrade to schema v15 filled in
pages per scan (1 / 25 / 200) only where it was empty and left existing scan
limits alone. A subscription keeps the limits it was sold with until its next
monthly reset, which re-reads the plan — yearly plans reset every month too.
A plan or subscription without a page limit falls back to the plan's current
value, then the shipped default.

Every limit is enforced on the server. Starting a scan is one write
transaction that refuses a second scan of a site that is still running, a
third scan running on one account, or a scan past the monthly allowance, and
otherwise claims one scan and creates the report — so requests fired together
cannot over-spend. The crawler stops at the plan's pages.

What a scan costs: refused before it starts — nothing; failed on our side or
site unreachable — refunded; finished, even if cut short by the time limit —
one scan.

Scans run as background jobs in the server process (`lib/scans/jobs.ts`, at
most `ANALYSIS_CONCURRENT_JOBS`, default 3, at once): `POST /api/analysis`
answers `202` with the report id and the page follows the report until it
finishes. Each job beats every 15 s; a scan whose process died stops beating
and is failed and refunded 90 s later. The time limit grows with the page
allowance (0.6 s per page past six, at most `ANALYSIS_MAX_DEADLINE_MS`,
default 4 minutes). Background scans need the long-running Node server
(`npm start`), not a serverless host.

Tests: `npm run test:limits` (builds first). A scan started through the API reads a site on the standard port 80, but the test needs no special rights: its fixture site listens on a free high port on 127.0.0.1, and the test's own hook (`scripts/fixtures/dns-hook.mjs`, loaded only into the test and its server) resolves the made-up `*-fixture.com` names to 127.0.0.1 and sends their port-80 connections to that port. Production code and other connections are untouched. Set `LIMITS_FIXTURE_PORT` to choose the port.

## Report

Findings are grouped into five areas — **Content, Policy, Trust, Technical, Smart insights** (`lib/report/areas.ts`) — shown as a summary row above the findings. The six score categories and their weights are unchanged; areas are worked out when a report is shown (analyzer lines carry their own, older rows map by check, feature and score category), so old reports group too. Each finding shows its status, area, priority, plain-English detail, the affected pages with evidence, the fix, and the analyzer's confidence when it is below high. The smart insights have their own section, marked as estimates. No wording claims a site will be rejected.

Locked checks stay visible with "Available on <plan>" from the live plan catalogue; they are never run for a plan that lacks them. The only "more found" number shown is honest and free: content pages the scan saw linked but did not read within the plan's pages per scan.

**PDF export** is the browser's print-to-PDF of the report page, with a print stylesheet: every section the report's plan includes, without locked checks, navigation or widgets; long URLs and evidence wrap; cards are not split across sheets. A report whose plan lacks PDF export prints an upgrade notice instead of the report, so printing follows the same rule as the button.

Tests: `npm run test:report` (builds first). It prints real PDFs in a browser: `playwright-core` is a dev dependency (installed by `npm install`; it contains no browser), and the browser is, in order, `CHROMIUM_PATH` if set, the Chromium from `npx playwright install chromium`, or an installed Google Chrome / Chromium. Its fixture sites use port 8080.

## Smart insights and weekly rescans (Pro)

Six report lines that read the finished scan (`lib/analysis/insights/`), toggled per plan like every analyzer: approval estimate, likely rejection reasons, similar-sites comparison (anonymous aggregates only, from 10 sites and 3 accounts in the same niche), changes since the last scan, readiness timeline (assumptions shown, never a date), and weekly rescans. They never change the score or the counts.

Weekly rescans are switched on per site from the report page. The same scheduler calls `POST /api/internal/jobs/rescans` (see [Scheduled jobs](#scheduled-jobs)).

Each due rescan runs through the normal scan path (plan, allowance and limits apply), at most three per call; an email is sent only when findings change. Expired plans pause schedules (off after 30 days), a used-up allowance pauses until it resets, failed scans retry after 1 and 6 hours and three failed weeks turn a schedule off — every attempt is logged in `schedule_runs`. The server also runs this every 5 minutes (`RESCANS_BACKGROUND=off` disables it).

Tests: `npm run test:insights` and `npm run test:insights-http` (builds first).

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
`ANALYSIS_*` variables plus `ALLOW_PRIVATE_ANALYSIS_HOSTS` tune the crawler. `SMTP_HOST`, `SMTP_PORT`,
`SMTP_SECURE`, `SMTP_USER`, `SMTP_APP_PASSWORD` and `EMAIL_FROM` send sign-up
verification codes and alerts through Google SMTP (Resend via `EMAIL_PROVIDER=resend`
is still supported) — without a working provider production refuses new
sign-ups (see "Email (Google SMTP)").

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
