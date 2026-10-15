#!/usr/bin/env bash
# Daily backup of the database and profile photos, kept for 14 days.
# Installed by setup.sh as /usr/local/bin/adsense-backup and run by
# /etc/cron.d/adsense at 03:15 (server time) as the `adsense` user.
#
# The SQLite copy uses sqlite3's online .backup, which is safe while the
# app is running. Backups stay on this VM: copy the newest one off the VM
# now and then (see README → Backups), because a lost VM loses them too.

set -euo pipefail

DATA="${ADSENSE_DATA_DIR:-/var/lib/adsense/data}"
OUT="${ADSENSE_BACKUP_DIR:-/var/lib/adsense/backups}"
KEEP_DAYS="${ADSENSE_BACKUP_DAYS:-14}"
stamp="$(date -u +%Y%m%d-%H%M%S)"

mkdir -p "$OUT"
if [ -f "$DATA/app.db" ]; then
  sqlite3 "$DATA/app.db" ".backup '$OUT/app-$stamp.db'"
  gzip -f "$OUT/app-$stamp.db"
  echo "$stamp database backed up: $OUT/app-$stamp.db.gz"
else
  echo "$stamp no database at $DATA/app.db yet — nothing to back up"
fi
if [ -d "$DATA/avatars" ]; then
  tar -czf "$OUT/avatars-$stamp.tar.gz" -C "$DATA" avatars
fi
find "$OUT" -maxdepth 1 -type f \( -name 'app-*.db.gz' -o -name 'avatars-*.tar.gz' \) -mtime +"$KEEP_DAYS" -delete
