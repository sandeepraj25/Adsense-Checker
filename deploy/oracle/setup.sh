#!/usr/bin/env bash
# One-time setup of the AdSense Checker on a fresh Oracle Cloud Ubuntu VM
# (Ampere A1 / arm64, or x86). Run as the default `ubuntu` user:
#
#   sudo bash setup.sh --domain example.com --from /home/ubuntu/upload
#       (code copied to the VM from your computer with rsync), or
#   sudo bash setup.sh --domain example.com --repo https://github.com/you/repo.git
#
# See deploy/oracle/README.md. The script is safe to run again:
# every step checks what is already there.
#
# What it does:
#   1. installs Node 22, git, sqlite3 and Caddy (HTTPS reverse proxy)
#   2. opens ports 80 and 443 in the VM's own firewall (the Oracle security
#      list must be opened separately in the web console)
#   3. creates the `adsense` system user, /opt/adsense/app (code) and
#      /var/lib/adsense (database, backups)
#   4. writes /etc/adsense/adsense.env from the template with fresh secrets
#      (only if it doesn't exist yet — an existing one is never touched)
#   5. installs dependencies and builds the app
#   6. installs the systemd service, the Caddy site, the scheduled-jobs cron
#      and a daily database backup
#
# It does NOT start the app until the settings file has been filled in.

set -euo pipefail

DOMAIN=""
REPO=""
FROM=""
APP_USER="adsense"
APP_DIR="/opt/adsense/app"
DATA_ROOT="/var/lib/adsense"
ENV_DIR="/etc/adsense"
ENV_FILE="$ENV_DIR/adsense.env"
PORT="3000"

while [ $# -gt 0 ]; do
  case "$1" in
    --domain) DOMAIN="${2:-}"; shift 2 ;;
    --repo) REPO="${2:-}"; shift 2 ;;
    --from) FROM="${2:-}"; shift 2 ;;
    -h|--help) sed -n '2,27p' "$0"; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done

say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
die() { printf '\nERROR: %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "run with sudo: sudo bash $0 --domain example.com"
[ -n "$DOMAIN" ] || die "--domain is required (e.g. --domain example.com)"
case "$DOMAIN" in
  http*|*/*|*" "*) die "--domain takes the bare name, e.g. example.com (no https://, no slash)" ;;
esac
. /etc/os-release
[ "${ID:-}" = "ubuntu" ] || echo "Warning: written for Ubuntu; this is ${PRETTY_NAME:-unknown}."

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ── 1. packages ────────────────────────────────────────────────
say "Installing system packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y ca-certificates curl gnupg git sqlite3 iptables-persistent netfilter-persistent \
  debian-keyring debian-archive-keyring apt-transport-https

node_ok() {
  command -v node >/dev/null 2>&1 || return 1
  node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=5)?0:1)'
}
if ! node_ok; then
  say "Installing Node.js 22"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
node_ok || die "Node.js 22.5 or newer is required; found $(node -v 2>/dev/null || echo none)"
echo "Node $(node -v), npm $(npm -v)"

if ! command -v caddy >/dev/null 2>&1; then
  say "Installing Caddy"
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  chmod o+r /usr/share/keyrings/caddy-stable-archive-keyring.gpg /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -y
  apt-get install -y caddy
fi

# ── 2. the VM's own firewall ───────────────────────────────────
say "Opening ports 80 and 443 in the VM firewall"
for p in 80 443; do
  if ! iptables -C INPUT -p tcp -m state --state NEW --dport "$p" -j ACCEPT 2>/dev/null; then
    iptables -I INPUT -p tcp -m state --state NEW --dport "$p" -j ACCEPT
  fi
done
netfilter-persistent save >/dev/null
if command -v ufw >/dev/null 2>&1 && ufw status | grep -q "Status: active"; then
  ufw allow 80/tcp >/dev/null
  ufw allow 443/tcp >/dev/null
fi

# ── 3. user and folders ────────────────────────────────────────
say "Creating the app user and folders"
id -u "$APP_USER" >/dev/null 2>&1 || useradd --system --create-home --home-dir "/home/$APP_USER" --shell /usr/sbin/nologin "$APP_USER"
install -d -o "$APP_USER" -g "$APP_USER" -m 750 /opt/adsense "$DATA_ROOT" "$DATA_ROOT/data" "$DATA_ROOT/backups"
install -d -o root -g "$APP_USER" -m 750 "$ENV_DIR"

if [ ! -f "$APP_DIR/package.json" ]; then
  if [ -n "$FROM" ]; then
    [ -f "$FROM/package.json" ] || die "--from $FROM does not contain the project (no package.json)"
    say "Copying the code from $FROM"
    install -d -o "$APP_USER" -g "$APP_USER" "$APP_DIR"
    # Code only: never a local database, settings or build output.
    tar -C "$FROM" --exclude=./node_modules --exclude=./.next --exclude=./data --exclude='./.env*' -cf - . | tar -C "$APP_DIR" -xf -
  elif [ -n "$REPO" ]; then
    say "Cloning $REPO"
    sudo -u "$APP_USER" git clone "$REPO" "$APP_DIR"
  else
    die "no code at $APP_DIR. Pass --from <folder> or --repo <git url> (see README)."
  fi
fi
chown -R "$APP_USER:$APP_USER" "$APP_DIR"
grep -q '"next"' "$APP_DIR/package.json" || die "$APP_DIR doesn't look like this project"

# ── 4. settings file ───────────────────────────────────────────
if [ ! -f "$ENV_FILE" ]; then
  say "Writing $ENV_FILE with new secrets"
  rnd_hex() { openssl rand -hex 32; }
  rnd_b64() { openssl rand -base64 48 | tr -d '\n'; }
  sed -e "s#^NEXT_PUBLIC_APP_URL=.*#NEXT_PUBLIC_APP_URL=https://$DOMAIN#" \
      -e "s#^AUTH_SECRET=__AUTO__#AUTH_SECRET=$(rnd_hex)#" \
      -e "s#^CREDENTIALS_SECRET=__AUTO__#CREDENTIALS_SECRET=$(rnd_b64)#" \
      -e "s#^CRON_SECRET=__AUTO__#CRON_SECRET=$(rnd_hex)#" \
      -e "s#^DATA_DIR=.*#DATA_DIR=$DATA_ROOT/data#" \
      "$SCRIPT_DIR/adsense.env.template" > "$ENV_FILE"
  CREATED_ENV=1
else
  echo "$ENV_FILE already exists — left as it is."
  CREATED_ENV=0
fi
chown root:"$APP_USER" "$ENV_FILE"
chmod 640 "$ENV_FILE"

# ── 5. build ───────────────────────────────────────────────────
say "Installing dependencies and building (a few minutes)"
cd "$APP_DIR"
sudo -u "$APP_USER" -H npm ci --no-audit --no-fund
sudo -u "$APP_USER" -H env NODE_ENV=production npm run build

# ── 6. service, proxy, cron, backups ──────────────────────────
say "Installing the systemd service, Caddy site, cron jobs and backups"
sed -e "s#__APP_DIR__#$APP_DIR#g" -e "s#__ENV_FILE__#$ENV_FILE#g" -e "s#__DATA_ROOT__#$DATA_ROOT#g" \
    -e "s#__PORT__#$PORT#g" -e "s#__USER__#$APP_USER#g" \
    "$SCRIPT_DIR/adsense.service" > /etc/systemd/system/adsense.service
systemctl daemon-reload
systemctl enable adsense >/dev/null

sed -e "s#__DOMAIN__#$DOMAIN#g" -e "s#__PORT__#$PORT#g" "$SCRIPT_DIR/Caddyfile" > /etc/caddy/Caddyfile
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/tmp/adsense-caddy-validate.log 2>&1 \
  || { cat /tmp/adsense-caddy-validate.log; die "the Caddy configuration is invalid"; }
systemctl enable caddy >/dev/null
systemctl reload caddy 2>/dev/null || systemctl restart caddy

install -m 755 "$SCRIPT_DIR/run-jobs.sh" /usr/local/bin/adsense-run-jobs
install -m 755 "$SCRIPT_DIR/backup.sh" /usr/local/bin/adsense-backup
cat > /etc/cron.d/adsense <<CRON
# AdSense Checker: scheduled jobs every 10 minutes, database backup daily.
SHELL=/bin/bash
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
*/10 * * * * $APP_USER /usr/local/bin/adsense-run-jobs >> $DATA_ROOT/jobs.log 2>&1
15 3 * * * $APP_USER /usr/local/bin/adsense-backup >> $DATA_ROOT/backups/backup.log 2>&1
CRON
chmod 644 /etc/cron.d/adsense
touch "$DATA_ROOT/jobs.log" && chown "$APP_USER:$APP_USER" "$DATA_ROOT/jobs.log"

# ── done ───────────────────────────────────────────────────────
say "Setup finished"
if [ "$CREATED_ENV" = 1 ]; then
  cat <<NEXT
Next steps:
  1. Fill in the settings:        sudo nano $ENV_FILE
     (ADMIN_EMAIL, ADMIN_PASSWORD, SMTP_USER, SMTP_APP_PASSWORD, EMAIL_FROM, payments)
  2. Start the app:               sudo systemctl start adsense
  3. Check it:                    sudo bash $SCRIPT_DIR/check.sh --domain $DOMAIN
NEXT
else
  systemctl restart adsense
  echo "The app was restarted with the existing settings. Check it with: sudo bash $SCRIPT_DIR/check.sh --domain $DOMAIN"
fi
