#!/usr/bin/env bash
# Runs outside the bot process (via a systemd timer) so it can warn the operator
# even when the bot itself is down. Alerts on recent Litestream errors via Telegram.
set -euo pipefail

: "${TELEGRAM_BOT_TOKEN:?TELEGRAM_BOT_TOKEN not set}"
: "${TELEGRAM_ALERT_CHAT_ID:?TELEGRAM_ALERT_CHAT_ID not set}"

UNIT="moonscout-litestream.service"
WINDOW="${HEALTHCHECK_WINDOW:-65min}"

error_count="$(journalctl -u "$UNIT" --since "-${WINDOW}" --no-pager 2>/dev/null \
  | grep -c 'level=ERROR' || true)"

if [ "${error_count:-0}" -eq 0 ]; then
  exit 0
fi

message="⚠️ moonscout: Litestream logged ${error_count} error line(s) in the last ${WINDOW}. Replication may be degraded. Investigate: journalctl -u ${UNIT} --since \"-${WINDOW}\""

curl -fsS --max-time 15 \
  "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
  --data-urlencode "chat_id=${TELEGRAM_ALERT_CHAT_ID}" \
  --data-urlencode "text=${message}" \
  >/dev/null
