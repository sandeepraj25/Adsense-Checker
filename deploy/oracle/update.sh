#!/usr/bin/env bash
# Deploys a new version and restarts the app:
#
#   sudo bash /opt/adsense/app/deploy/oracle/update.sh --pull
#       pulls the latest commit from git, or
#   sudo bash /opt/adsense/app/deploy/oracle/update.sh --from /home/ubuntu/upload
#       uses code you copied to the VM (rsync from your computer).
#
# The new version is installed and built in a separate folder first; the
# running app is only swapped over if the build succeeds, so a failed
# build never takes the site down. The previous version is kept in
# /opt/adsense/previous for a quick rollback (see README). A database
# backup is taken before the switch.

set -euo pipefail
[ "$(id -u)" -eq 0 ] || { echo "run with sudo" >&2; exit 1; }

APP_DIR="/opt/adsense/app"
NEW_DIR="/opt/adsense/incoming"
OLD_DIR="/opt/adsense/previous"
MODE="${1:-}"
SRC="${2:-}"

rm -rf "$NEW_DIR" "$NEW_DIR.failed"
case "$MODE" in
  --pull)
    cp -a "$APP_DIR" "$NEW_DIR"
    chown -R adsense:adsense "$NEW_DIR"
    sudo -u adsense -H git -C "$NEW_DIR" pull --ff-only
    ;;
  --from)
    [ -n "$SRC" ] && [ -f "$SRC/package.json" ] || { echo "--from needs a folder containing the project" >&2; exit 2; }
    mkdir -p "$NEW_DIR"
    # Code only: never the data folder, local settings or build output.
    tar -C "$SRC" --exclude=./node_modules --exclude=./.next --exclude=./data --exclude='./.env*' -cf - . | tar -C "$NEW_DIR" -xf -
    chown -R adsense:adsense "$NEW_DIR"
    ;;
  *)
    echo "Usage: update.sh --pull | --from <folder>" >&2; exit 2 ;;
esac

echo "==> Installing and building the new version"
cd "$NEW_DIR"
sudo -u adsense -H npm ci --no-audit --no-fund
sudo -u adsense -H env NODE_ENV=production npm run build

echo "==> Backing up the database"
/usr/local/bin/adsense-backup || echo "Warning: the backup failed — continuing"

echo "==> Switching over"
rm -rf "$OLD_DIR"
mv "$APP_DIR" "$OLD_DIR"
mv "$NEW_DIR" "$APP_DIR"
install -m 755 "$APP_DIR/deploy/oracle/run-jobs.sh" /usr/local/bin/adsense-run-jobs
install -m 755 "$APP_DIR/deploy/oracle/backup.sh" /usr/local/bin/adsense-backup
systemctl restart adsense
up=0
for _ in $(seq 1 30); do
  if curl -fsS -o /dev/null --max-time 5 http://127.0.0.1:3000/pricing; then up=1; break; fi
  sleep 1
done
if [ "$up" = 1 ]; then
  echo "Updated and running. The previous version is in $OLD_DIR."
else
  echo "The new version did not start. Rolling back." >&2
  mv "$APP_DIR" "$NEW_DIR.failed" && mv "$OLD_DIR" "$APP_DIR"
  systemctl restart adsense
  echo "Rolled back. Logs: sudo journalctl -u adsense -n 80" >&2
  exit 1
fi
