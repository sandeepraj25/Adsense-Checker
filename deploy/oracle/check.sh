#!/usr/bin/env bash
# Checks a deployment on this VM and says what works and what doesn't:
#
#   sudo bash check.sh --domain example.com
#
# Read-only, except that it runs the scheduled jobs once (exactly what the
# cron does every 10 minutes anyway).

set -uo pipefail

DOMAIN=""
while [ $# -gt 0 ]; do
  case "$1" in
    --domain) DOMAIN="${2:-}"; shift 2 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done
[ -n "$DOMAIN" ] || { echo "Usage: sudo bash check.sh --domain example.com" >&2; exit 2; }

ENV_FILE="/etc/adsense/adsense.env"
PORT="3000"
fails=0
ok()   { printf '  \033[32mPASS\033[0m %s\n' "$*"; }
bad()  { printf '  \033[31mFAIL\033[0m %s\n' "$*"; fails=$((fails + 1)); }
info() { printf '  ---- %s\n' "$*"; }
val()  { grep -E "^$1=" "$ENV_FILE" 2>/dev/null | tail -n 1 | cut -d= -f2- | tr -d '\r'; }

echo "Settings"
if [ -r "$ENV_FILE" ]; then
  ok "settings file $ENV_FILE exists"
  for k in AUTH_SECRET CREDENTIALS_SECRET CRON_SECRET NEXT_PUBLIC_APP_URL DATA_DIR SMTP_USER SMTP_APP_PASSWORD EMAIL_FROM; do
    v="$(val "$k")"
    if [ -z "$v" ] || [ "$v" = "__AUTO__" ]; then bad "$k is empty"; else ok "$k is set"; fi
  done
  [ "$(val NEXT_PUBLIC_APP_URL)" = "https://$DOMAIN" ] || bad "NEXT_PUBLIC_APP_URL should be https://$DOMAIN (is: $(val NEXT_PUBLIC_APP_URL))"
else
  bad "no readable settings file at $ENV_FILE (run with sudo)"
fi

echo "App"
if systemctl is-active --quiet adsense; then ok "service adsense is running"; else bad "service adsense is not running (sudo journalctl -u adsense -n 50)"; fi
code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "http://127.0.0.1:$PORT/pricing")"
[ "$code" = "200" ] && ok "app answers on 127.0.0.1:$PORT" || bad "app on 127.0.0.1:$PORT answered $code"

echo "Domain and HTTPS"
public_ip="$(curl -s --max-time 10 https://ifconfig.me || true)"
dns_ip="$(getent ahostsv4 "$DOMAIN" | awk 'NR==1{print $1}')"
info "this VM's public IP: ${public_ip:-unknown}; $DOMAIN resolves to: ${dns_ip:-nothing}"
if [ -n "$dns_ip" ] && [ "$dns_ip" = "$public_ip" ]; then ok "DNS points $DOMAIN to this VM"; else bad "DNS for $DOMAIN does not point to this VM yet (add an A record → ${public_ip:-the VM IP})"; fi
if systemctl is-active --quiet caddy; then ok "Caddy is running"; else bad "Caddy is not running (sudo journalctl -u caddy -n 50)"; fi
code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 "https://$DOMAIN/pricing")"
[ "$code" = "200" ] && ok "https://$DOMAIN works with a valid certificate" || bad "https://$DOMAIN/pricing answered '$code' (open ports 80/443 in the Oracle security list; check DNS; sudo journalctl -u caddy)"
code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 "http://$DOMAIN/")"
case "$code" in 301|302|308) ok "http:// redirects to https://" ;; *) bad "http://$DOMAIN answered '$code' instead of a redirect" ;; esac

echo "Email"
host="$(val SMTP_HOST)"; host="${host:-smtp.gmail.com}"
port="$(val SMTP_PORT)"; port="${port:-587}"
if timeout 8 bash -c "exec 3<>/dev/tcp/$host/$port" 2>/dev/null; then
  ok "can reach $host:$port (the mail server); send a real test from Admin → Notifications → Send test"
else
  bad "cannot reach $host:$port from this VM — Oracle may be blocking it; use OCI Email Delivery (see README)"
fi

echo "Scheduled jobs"
if out="$(sudo -u adsense /usr/local/bin/adsense-run-jobs 2>&1)"; then
  ok "all three jobs ran:"; printf '%s\n' "$out" | sed 's/^/         /'
  info "Admin → Settings → Notifications → Scheduled jobs should now say Verified"
else
  bad "a scheduled job failed:"; printf '%s\n' "$out" | sed 's/^/         /'
fi
grep -q adsense-run-jobs /etc/cron.d/adsense 2>/dev/null && ok "cron runs them every 10 minutes" || bad "/etc/cron.d/adsense is missing"

echo "Backups"
ls /var/lib/adsense/backups/app-*.db.gz >/dev/null 2>&1 && ok "a database backup exists" || info "no backup yet (the first runs tonight; or: sudo -u adsense adsense-backup)"

echo
if [ "$fails" -eq 0 ]; then echo "All checks passed."; else echo "$fails check(s) failed — see above."; fi
exit $(( fails > 0 ))
