#! /usr/bin/env bash
# Install the Overleaf backup systemd service + timer.
#
# Usage:
#   sudo scripts/install-systemd.sh            # install and enable the timer
#   sudo scripts/install-systemd.sh --no-enable
#
# Writes /etc/systemd/system/overleaf-backup.{service,timer} from the tracked
# templates in systemd/, substituting the toolkit root path.

set -euo pipefail

command -v realpath >/dev/null 2>&1 || realpath() {
  [[ $1 = /* ]] && echo "$1" || echo "$PWD/${1#./}"
}
SCRIPT_PATH="$(realpath "${BASH_SOURCE[0]}")"
SCRIPT_DIR="$(dirname "$SCRIPT_PATH")"
TOOLKIT_ROOT="$(realpath "$SCRIPT_DIR/..")"

ENABLE=1
case "${1:-}" in
  --no-enable) ENABLE=0 ;;
  -h|--help) sed -n '2,10p' "$0"; exit 0 ;;
esac

[[ "$(id -u)" == "0" ]] || { echo "ERROR: run this script as root." >&2; exit 1; }
[[ -f /etc/overleaf-backup/backup.env ]] || {
  echo "WARNING: /etc/overleaf-backup/backup.env not found."
  echo "Run scripts/setup-r2.sh first to create rclone config and backup.env."
}

sed "s|__TOOLKIT_ROOT__|$TOOLKIT_ROOT|g" \
  "$TOOLKIT_ROOT/systemd/overleaf-backup.service" \
  > /etc/systemd/system/overleaf-backup.service
cp "$TOOLKIT_ROOT/systemd/overleaf-backup.timer" /etc/systemd/system/overleaf-backup.timer

systemctl daemon-reload

if [[ "$ENABLE" == "1" ]]; then
  systemctl enable --now overleaf-backup.timer
  echo "Installed and enabled overleaf-backup.timer."
else
  echo "Installed overleaf-backup.timer (not enabled)."
fi

systemctl list-timers overleaf-backup.timer --no-pager || true
