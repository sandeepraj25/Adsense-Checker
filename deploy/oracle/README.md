# Deploying on an Oracle Cloud Always Free VM

This folder has everything to run the AdSense Checker on one Oracle Cloud
VM with your own domain and HTTPS:

| File | What it is |
| --- | --- |
| `setup.sh` | One-time install: Node 22, Caddy, firewall, app user, settings file, build, service, cron, backups |
| `adsense.env.template` | The production settings; becomes `/etc/adsense/adsense.env` |
| `adsense.service` | systemd service: starts the app on boot, restarts it if it crashes |
| `Caddyfile` | HTTPS in front of the app (free Let's Encrypt certificate, renewed automatically) |
| `run-jobs.sh` | Runs the three scheduled jobs; cron calls it every 10 minutes |
| `backup.sh` | Daily database + photo backup, kept 14 days |
| `check.sh` | Checks the deployment and says what works and what doesn't |
| `update.sh` | Deploys a new version safely (builds first, rolls back if it won't start) |

Where things end up on the VM:

```
/opt/adsense/app              the code
/etc/adsense/adsense.env      your settings and secrets (root + app user only)
/var/lib/adsense/data         database (app.db) and profile photos
/var/lib/adsense/backups      daily backups
/var/lib/adsense/jobs.log     scheduled-job runs
```

---

## 1. Create the VM (Oracle web console)

1. Sign up at cloud.oracle.com. Pick your **home region** carefully — Always
   Free VMs can only be created there (e.g. Mumbai or Hyderabad for India).
2. **Compute → Instances → Create instance**
   - Image: **Ubuntu 24.04** (or 22.04).
   - Shape: **Ampere → VM.Standard.A1.Flex**, **2 OCPUs, 12 GB memory**
     (the Always Free maximum). Don't use the 1 GB "Micro" shape — the build
     runs out of memory.
   - Networking: create a new VCN with a **public subnet**, and tick
     **Assign a public IPv4 address**.
   - SSH keys: **Generate a key pair** and download the private key (or
     paste your own public key).
   - Boot volume: the default (about 50 GB) is fine; up to 200 GB is free.
   - If you get "Out of host capacity", try another availability domain or
     try again later.
3. Note the instance's **Public IP address**.
4. **Open ports 80 and 443 in Oracle's firewall:** Instance → Subnet →
   **Security List** (Default Security List) → **Add Ingress Rules**:
   - Source CIDR `0.0.0.0/0`, IP protocol TCP, destination port `80`
   - Source CIDR `0.0.0.0/0`, IP protocol TCP, destination port `443`

   (The VM has a second firewall of its own; `setup.sh` opens that one.)

## 2. Point your domain at the VM

At your domain registrar's DNS settings:

- **A record**: name `@` (the bare domain) → the VM's public IP.
- Optional: **A record** `www` → the same IP (then enable the `www` block
  in `/etc/caddy/Caddyfile`).
- If an old AAAA (IPv6) record points elsewhere, remove it.

DNS can take a few minutes to a few hours. Check from your computer:
`nslookup your-domain.com` should show the VM's IP.

## 3. Copy the project to the VM

From your Mac, in the project folder (replace the key path and IP):

```bash
rsync -az --delete \
  --exclude node_modules --exclude .next --exclude data --exclude '.env*' --exclude .git \
  -e "ssh -i ~/Downloads/ssh-key.key" \
  ./ ubuntu@VM_IP:/home/ubuntu/upload/
```

This copies the code only — never your local database, `.env.local` or
secrets. (Or push to GitHub and use `--repo` below instead of `--from`.)

## 4. Run the setup

```bash
ssh -i ~/Downloads/ssh-key.key ubuntu@VM_IP
cd /home/ubuntu/upload/deploy/oracle
sudo bash setup.sh --domain your-domain.com --from /home/ubuntu/upload
```

It takes a few minutes (mostly `npm ci` and the build). At the end it
creates `/etc/adsense/adsense.env` with fresh random secrets
(`AUTH_SECRET`, `CREDENTIALS_SECRET`, `CRON_SECRET`) and asks you to fill in
the rest.

## 5. Fill in the settings and start

```bash
sudo nano /etc/adsense/adsense.env
```

Fill in at least: `ADMIN_EMAIL`, `ADMIN_PASSWORD` (the first admin login),
`SMTP_USER`, `SMTP_APP_PASSWORD` (a Google App Password), `EMAIL_FROM`, and
your payment keys (or add those later in Admin → Payment gateways). Then:

```bash
sudo systemctl start adsense
sudo bash /home/ubuntu/upload/deploy/oracle/check.sh --domain your-domain.com
```

`check.sh` prints PASS/FAIL for: settings, the app, DNS, HTTPS, the mail
server, the scheduled jobs and backups. Fix anything marked FAIL and run it
again.

Then in a browser:

1. Open `https://your-domain.com` — the padlock should show.
2. Log in with the admin email and password.
3. Admin → Settings → Notifications: set the alert email, press **Send
   test**, and check your inbox.
4. The **Scheduled jobs** panel should say **Verified** for all three jobs
   (cron runs them every 10 minutes; `check.sh` ran them once already).
5. Sign up with a second email address to confirm sign-up codes arrive.

### Payment webhooks

In each gateway's dashboard, set the webhook URL to your new domain:

- Razorpay: `https://your-domain.com/api/webhooks/razorpay`
- Cashfree: `https://your-domain.com/api/webhooks/cashfree`
- PayPal: `https://your-domain.com/api/webhooks/paypal`

## Email from Oracle Cloud

Oracle blocks outgoing port **25** for new accounts. The app uses Gmail on
port **587**, which Oracle's documentation does not list as blocked —
`check.sh` tests that the mail server can be reached, and **Send test** in
the admin panel proves delivery.

If Gmail can't be reached, use **OCI Email Delivery** (3,000 emails a month
free): Developer Services → Email Delivery → create an Approved Sender for
your `EMAIL_FROM` address, set up SPF/DKIM for your domain as shown there,
and generate SMTP credentials (Identity → your user → SMTP Credentials).
Then in `/etc/adsense/adsense.env`:

```
SMTP_HOST=smtp.email.<your-region>.oci.oraclecloud.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=<the SMTP credential username>
SMTP_APP_PASSWORD=<the SMTP credential password>
EMAIL_FROM=AdSense Checker <the approved sender address>
```

and `sudo systemctl restart adsense`.

## Updating to a new version

Copy the new code to the VM (same rsync as step 3), then:

```bash
sudo bash /opt/adsense/app/deploy/oracle/update.sh --from /home/ubuntu/upload
```

(or `--pull` if the VM uses `git`). The new version is built in a separate
folder while the site keeps running; it only switches over if the build
succeeds, takes a database backup first, and rolls back automatically if
the new version doesn't start. The previous version stays in
`/opt/adsense/previous`.

## Backups

A backup of the database and profile photos is made every night at 03:15
(server time, UTC by default) into `/var/lib/adsense/backups` and kept 14
days. Those copies are on the same VM, so also copy one off now and then:

```bash
# on your Mac
scp -i ~/Downloads/ssh-key.key "ubuntu@VM_IP:/var/lib/adsense/backups/app-*.db.gz" ~/adsense-backups/
```

(`sudo chmod o+rx /var/lib/adsense /var/lib/adsense/backups` once, or copy
the file to `/home/ubuntu` first with sudo.) You can also enable Oracle
boot-volume backups (5 are free).

To restore:

```bash
sudo systemctl stop adsense
sudo rm -f /var/lib/adsense/data/app.db-wal /var/lib/adsense/data/app.db-shm
sudo sh -c 'gunzip -c /var/lib/adsense/backups/app-YYYYMMDD-HHMMSS.db.gz > /var/lib/adsense/data/app.db'
sudo chown adsense:adsense /var/lib/adsense/data/app.db
sudo systemctl start adsense
```

## Moving an existing production database

If a site is already running elsewhere with real users, copy its
`DATA_DIR` contents (`app.db`, `avatars/`) into `/var/lib/adsense/data`
(owned by `adsense`) **and** put that server's `AUTH_SECRET` and
`CREDENTIALS_SECRET` into `/etc/adsense/adsense.env` before starting —
otherwise everyone is logged out and the payment-gateway keys saved in the
admin panel can't be decrypted. Don't copy your Mac's development database
to production.

## Good to know

- **Idle reclamation.** Oracle can reclaim an Always Free VM that is idle
  for 7 days (CPU, network and memory all under 20%). A quiet new site can
  hit this. Upgrading the account to Pay-As-You-Go (still free within the
  free limits) is the usual way people avoid it; check Oracle's current
  terms before relying on that, and keep off-VM backups either way.
- **Useful commands:**
  - `sudo systemctl status adsense` / `sudo journalctl -u adsense -f` — the app and its log
  - `sudo journalctl -u caddy -n 50` — HTTPS/certificate problems
  - `tail /var/lib/adsense/jobs.log` — scheduled-job runs
  - `sudo systemctl restart adsense` — after changing the settings file
- **Site doesn't load:** usually the Oracle security list (step 1.4) or DNS
  (step 2). `check.sh` tells you which.
