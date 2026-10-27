#!/bin/sh
# Restore drill (run monthly against a scratch database and record the result).
# Usage: restore.sh /backups/hms-<stamp>.dump.age <age-identity-file> <target-db>
set -eu
BACKUP=$1; IDENTITY=$2; TARGET=${3:-hms_restore_check}
TMP=$(mktemp /tmp/hms-restore.XXXXXX.dump)
age -d -i "$IDENTITY" -o "$TMP" "$BACKUP"
createdb -h db -U hms_owner "$TARGET"
pg_restore -h db -U hms_owner -d "$TARGET" --no-owner --no-privileges "$TMP"
psql -h db -U hms_owner -d "$TARGET" -Atc "SELECT 'patients='||count(*) FROM patients; SELECT 'audit='||count(*) FROM audit_log;"
psql -h db -U hms_owner -d "$TARGET" -Atc "SELECT 'chain_ok='||(SELECT bool_and(prev_hash = lag(hash) OVER (ORDER BY id)) IS NOT FALSE FROM audit_log);"
dropdb -h db -U hms_owner "$TARGET"
rm -f "$TMP"
echo "restore drill completed for $TARGET"
