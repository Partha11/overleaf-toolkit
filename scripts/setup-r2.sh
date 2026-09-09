#! /usr/bin/env bash
# Set up rclone for Overleaf backups against a dedicated Cloudflare R2 bucket.
#
# This creates (or overwrites) /etc/overleaf-backup/rclone.conf containing two
# remotes:
#   r2:        the Cloudflare R2 S3 backend for the dedicated backup bucket
#   r2-crypt:  an rclone crypt remote layered on top of it
#
# Backup archives are uploaded through r2-crypt so that filenames and contents
# are encrypted client-side before reaching R2.
#
# Secrets may be provided via environment variables (R2_ACCOUNT_ID,
# R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET) or interactively.
# Nothing secret is written anywhere except the root-only rclone.conf.

set -euo pipefail

R2_ACCOUNT_ID="${R2_ACCOUNT_ID:-}"
R2_ACCESS_KEY_ID="${R2_ACCESS_KEY_ID:-}"
R2_SECRET_ACCESS_KEY="${R2_SECRET_ACCESS_KEY:-}"
R2_BUCKET="${R2_BUCKET:-overleaf}"
BACKUP_ETC_DIR="${BACKUP_ETC_DIR:-/etc/overleaf-backup}"
RCLONE_BIN="${RCLONE_BIN:-rclone}"

command -v "$RCLONE_BIN" >/dev/null || {
  echo "ERROR: rclone is not installed. Install it first, e.g.:"
  echo "  sudo dnf install rclone     # Fedora"
  echo "  sudo apt install rclone     # Debian/Ubuntu"
  exit 1
}
[[ "$(id -u)" == "0" ]] || { echo "ERROR: run this script as root (it writes $BACKUP_ETC_DIR)." >&2; exit 1; }

prompt() { # prompt VARNAME LABEL
  local varname="$1" label="$2"
  if [[ -z "${!varname:-}" ]]; then
    read -r -p "$label: " "$varname"
  fi
}

prompt R2_ACCOUNT_ID "Cloudflare R2 Account ID (dashboards under R2 -> Account ID)"
prompt R2_ACCESS_KEY_ID "R2 API Token Access Key ID (bucket-scoped, read+write)"
prompt R2_SECRET_ACCESS_KEY "R2 API Token Secret Access Key"
prompt R2_BUCKET "R2 bucket name (dedicated to Overleaf backups)"

# Generate two fresh random secrets for the rclone crypt remote. The values are
# stored in the config file OBSCURED with `rclone obscure`, which is the format
# rclone expects for crypt passwords. Writing the raw `openssl rand -base64`
# output directly into the config is fragile: rclone must base64-decode the
# stored value to "reveal" the password, and any mangling (padding, whitespace)
# makes it fail with "base64 decode failed when revealing password".
CRYPT_PASSWORD="$(openssl rand -base64 32)"
CRYPT_PASSWORD2="$(openssl rand -base64 32)"
OBSCURED_PASSWORD="$("$RCLONE_BIN" obscure "$CRYPT_PASSWORD")"
OBSCURED_PASSWORD2="$("$RCLONE_BIN" obscure "$CRYPT_PASSWORD2")"

mkdir -p "$BACKUP_ETC_DIR"
umask 077

# Preserve the previous config before overwriting: regenerating the crypt
# passwords makes any previously uploaded (encrypted) backups unreadable.
if [[ -f "$BACKUP_ETC_DIR/rclone.conf" ]]; then
  local_backup="$BACKUP_ETC_DIR/rclone.conf.bak.$(date "+%Y.%m.%d-%H.%M.%S")"
  cp -a "$BACKUP_ETC_DIR/rclone.conf" "$local_backup"
  chmod 600 "$local_backup"
  echo "Backed up existing config to $local_backup"
  echo "WARNING: replacing the crypt passwords will make any existing encrypted"
  echo "         backups in R2 unreadable. Only proceed if that is expected."
fi

cat > "$BACKUP_ETC_DIR/rclone.conf" <<EOF
# rclone configuration for Overleaf backups. Root-only (chmod 600).
# Created by scripts/setup-r2.sh - do not commit this file.
[r2]
type = s3
provider = Cloudflare
access_key_id = ${R2_ACCESS_KEY_ID}
secret_access_key = ${R2_SECRET_ACCESS_KEY}
endpoint = https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com
region = auto
acl = private

[r2-crypt]
type = crypt
remote = r2:${R2_BUCKET}
filename_encryption = standard
directory_name_encryption = true
password = ${OBSCURED_PASSWORD}
password2 = ${OBSCURED_PASSWORD2}
EOF

chmod 600 "$BACKUP_ETC_DIR/rclone.conf"

if [[ ! -f "$BACKUP_ETC_DIR/backup.env" ]]; then
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  TOOLKIT_ROOT="$(realpath "$SCRIPT_DIR/..")"
  cp "$TOOLKIT_ROOT/scripts/backup.env.example" "$BACKUP_ETC_DIR/backup.env"
  chmod 600 "$BACKUP_ETC_DIR/backup.env"
  echo "Created $BACKUP_ETC_DIR/backup.env from the example template."
fi

echo "Wrote $BACKUP_ETC_DIR/rclone.conf (chmod 600)."
echo
echo "Bucket '$R2_BUCKET' must exist and should be created in the EU location:"
echo
echo "  Option A - Cloudflare dashboard:"
echo "    R2 -> Create bucket -> name '$R2_BUCKET' -> Location: EU"
echo "    Then create an API Token scoped to ONLY this bucket with object"
echo "    read & write permissions, and use it for this backup setup."
echo
echo "  Option B - aws CLI (creates the bucket in EU):"
echo "    AWS_ACCESS_KEY_ID=$R2_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY=<secret> \\"
echo "      aws s3api create-bucket --endpoint-url https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com \\"
echo "      --bucket $R2_BUCKET --region auto --create-bucket-configuration LocationConstraint=EU"
echo
echo "Verifying the new config (lsd r2-crypt:) ..."
if "$RCLONE_BIN" --config "$BACKUP_ETC_DIR/rclone.conf" lsd r2-crypt: >/dev/null 2>&1; then
  echo "OK: can list r2-crypt: - crypt password and credentials are valid."
else
  echo "WARNING: could not list r2-crypt: - the rclone config may be invalid, or the"
  echo "         bucket/token may be wrong. Debug with:"
  echo "  sudo $RCLONE_BIN --config $BACKUP_ETC_DIR/rclone.conf lsd r2-crypt:"
fi
