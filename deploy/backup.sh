#!/usr/bin/env bash
# Nightly backup of the database and uploaded files. Keeps 14 days. Copy /var/backups/expensechat off this machine too.
set -euo pipefail
cd /opt/expensechat
set -a; . ./.env; set +a
out=/var/backups/expensechat; day=$(date +%F); mkdir -p "$out"
case "$DATABASE_URL" in
  sqlite:*) sqlite3 "${DATABASE_URL#sqlite:}" ".backup '$out/db-$day.sqlite'" ;;
  mysql:*)  mysqldump --single-transaction expensechat | gzip > "$out/db-$day.sql.gz" ;;
esac
tar -czf "$out/uploads-$day.tar.gz" -C "$UPLOAD_DIR" .
find "$out" -type f -mtime +14 -delete
