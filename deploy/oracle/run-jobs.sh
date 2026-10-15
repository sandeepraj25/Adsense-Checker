#!/usr/bin/env bash
# Runs the three scheduled jobs (checkout alerts, prediction feedback,
# weekly rescans) through the app on this VM. Installed by setup.sh as
# /usr/local/bin/adsense-run-jobs and called by /etc/cron.d/adsense every
# 10 minutes as the `adsense` user.
#
# It calls the app directly on 127.0.0.1 (no DNS or certificate involved)
# with the CRON_SECRET from the settings file. Each call is recorded by the
# app, so Admin → Settings → Notifications → Scheduled jobs shows
# "Verified" once this has run.

set -euo pipefail

ENV_FILE="${ADSENSE_ENV_FILE:-/etc/adsense/adsense.env}"
APP_DIR="${ADSENSE_APP_DIR:-/opt/adsense/app}"
PORT="${ADSENSE_PORT:-3000}"

# Read just this one value; the file is not sourced (values may hold spaces).
secret="$(grep -E '^CRON_SECRET=' "$ENV_FILE" | tail -n 1 | cut -d= -f2- | tr -d '\r' | sed -e 's/^"//' -e 's/"$//')"

printf '%s ' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
APP_URL="http://127.0.0.1:$PORT" CRON_SECRET="$secret" \
  exec node "$APP_DIR/scripts/run-scheduled-jobs.mjs" "$@"
