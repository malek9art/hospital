#!/bin/sh
# Encrypted logical backup. Target: RPO 15 minutes (WAL archiving in production),
# this script provides the daily full logical dump with 30-day retention.
set -eu
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
OUT="/backups/hms-${STAMP}.dump.age"
pg_dump -h db -U hms_owner -d hms -Fc --no-owner --no-privileges \
  | age -r "$AGE_RECIPIENT" -o "$OUT"
pg_dump -h db -U hms_owner -d hms -Fc --no-owner --no-privileges > /dev/null 2>&1 || true
# Integrity check before pruning anything.
test -s "$OUT" || { echo "backup empty: $OUT" >&2; exit 1; }
find /backups -name 'hms-*.dump.age' -type f -mtime +30 -delete
echo "backup written: $OUT ($(wc -c < "$OUT") bytes)"
