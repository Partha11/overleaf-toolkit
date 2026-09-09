#! /usr/bin/env bash
# Overleaf Toolkit restore script.
#
# Restores an Overleaf instance from a backup archive produced by
# scripts/backup-overleaf.sh. Supports restoring from a local archive or from a
# backup stored in the encrypted Cloudflare R2 bucket.
#
# Usage:
#   restore-overleaf.sh --verify <archive>
#   restore-overleaf.sh --dry-run --archive <archive>
#   restore-overleaf.sh --dry-run --from-r2 <backup-name>
#   restore-overleaf.sh --archive <archive> --yes
#   restore-overleaf.sh --from-r2 <backup-name> --yes
#
# The --yes flag is required for an actual (destructive) restore.

set -euo pipefail

RESTORE_SCRIPT_VERSION="1.0.0"

#### Detect Toolkit Project Root ####
command -v realpath >/dev/null 2>&1 || realpath() {
  [[ $1 = /* ]] && echo "$1" || echo "$PWD/${1#./}"
}
SCRIPT_PATH="$(realpath "${BASH_SOURCE[0]}")"
SCRIPT_DIR="$(dirname "$SCRIPT_PATH")"
TOOLKIT_ROOT="$(realpath "$SCRIPT_DIR/..")"
if [[ ! -d "$TOOLKIT_ROOT/bin" ]] || [[ ! -d "$TOOLKIT_ROOT/config" ]]; then
  echo "ERROR: could not find root of overleaf-toolkit project (inferred project root as '$TOOLKIT_ROOT')" >&2
  exit 1
fi

#### Configuration defaults (overridable via /etc/overleaf-backup/backup.env or the environment) ####
RESTORE_WORK_DIR="${RESTORE_WORK_DIR:-/var/lib/overleaf-backups/restore}"
RCLONE_BIN="${RCLONE_BIN:-rclone}"
RCLONE_CONFIG="${RCLONE_CONFIG:-/etc/overleaf-backup/rclone.conf}"
RCLONE_REMOTE="${RCLONE_REMOTE:-r2-crypt}"
R2_BACKUP_PATH="${R2_BACKUP_PATH:-overleaf}"
MONGO_DB="${MONGO_DB:-sharelatex}"
MONGO_CONTAINER="${MONGO_CONTAINER:-}"
REDIS_CONTAINER="${REDIS_CONTAINER:-}"
SHARELATEX_CONTAINER="${SHARELATEX_CONTAINER:-}"

if [[ -f /etc/overleaf-backup/backup.env ]]; then
  set -a
  # shellcheck disable=SC1091
  source /etc/overleaf-backup/backup.env
  set +a
fi

log() { echo "[overleaf-restore] $*" >&2; }
die() { echo "[overleaf-restore] ERROR: $*" >&2; exit 1; }

# shellcheck disable=SC1091
source "$TOOLKIT_ROOT/lib/shared-functions.sh"

toolkit_read() { read_configuration "$1"; }

OVERLEAF_DATA_PATH="$(realpath "$TOOLKIT_ROOT/$(toolkit_read OVERLEAF_DATA_PATH)")"
MONGO_DATA_PATH="$(realpath "$TOOLKIT_ROOT/$(toolkit_read MONGO_DATA_PATH)")"
REDIS_DATA_PATH="$(realpath "$TOOLKIT_ROOT/$(toolkit_read REDIS_DATA_PATH)")"
GIT_BRIDGE_ENABLED="$(toolkit_read GIT_BRIDGE_ENABLED)"

if [[ -z "$MONGO_CONTAINER" ]]; then
  MONGO_CONTAINER="$(cd "$TOOLKIT_ROOT" && bin/docker-compose ps -q mongo 2>/dev/null || true)"
  [[ -z "$MONGO_CONTAINER" ]] && MONGO_CONTAINER="mongo"
fi
if [[ -z "$REDIS_CONTAINER" ]]; then
  REDIS_CONTAINER="$(cd "$TOOLKIT_ROOT" && bin/docker-compose ps -q redis 2>/dev/null || true)"
  [[ -z "$REDIS_CONTAINER" ]] && REDIS_CONTAINER="redis"
fi
if [[ -z "$SHARELATEX_CONTAINER" ]]; then
  SHARELATEX_CONTAINER="$(cd "$TOOLKIT_ROOT" && bin/docker-compose ps -q sharelatex 2>/dev/null || true)"
  [[ -z "$SHARELATEX_CONTAINER" ]] && SHARELATEX_CONTAINER="sharelatex"
fi

rclone_cmd() { "$RCLONE_BIN" --config "$RCLONE_CONFIG" "$@"; }

#### Archive verification (mirrors backup-overleaf.sh --verify) ####
verify_archive() {
  local archive="$1" tmpdir
  [[ -f "$archive" ]] || die "archive not found: $archive"
  log "Verifying archive integrity: $archive"
  command -v zstd >/dev/null || die "zstd not installed"
  zstd -t "$archive" || die "zstd integrity check failed"
  tar -tf "$archive" >/dev/null || die "archive is not a readable tar"

  tmpdir="$(mktemp -d)"
  trap 'rm -rf "$tmpdir"' RETURN
  tar -xf "$archive" -C "$tmpdir"
  for required in metadata/checksums.sha256 metadata/backup-info.txt \
                  mongodb/dump.archive.gz redis/redis-data.tar \
                  overleaf/overleaf-data.tar config/config.tar; do
    [[ -f "$tmpdir/$required" ]] || die "backup is missing: $required"
  done
  log "Verifying component checksums..."
  local ok=1 sum rel
  while read -r sum rel; do
    [[ -n "$rel" ]] || continue
    if ! ( cd "$tmpdir" && echo "$sum  $rel" | sha256sum -c --status ); then
      log "CHECKSUM MISMATCH: $rel"
      ok=0
    fi
  done < "$tmpdir/metadata/checksums.sha256"
  [[ "$ok" == "1" ]] || die "backup verification FAILED"
  log "Backup verified OK: $(basename "$archive")"
  log "--- backup-info.txt ---"
  cat "$tmpdir/metadata/backup-info.txt"
}

#### Download a backup from R2 ####
fetch_from_r2() {
  local name="$1" dest_dir="$2"
  mkdir -p "$dest_dir"
  local found=""
  local prefix
  for prefix in daily weekly monthly; do
    if rclone_cmd lsl "$RCLONE_REMOTE:$R2_BACKUP_PATH/$prefix/$name" >/dev/null 2>&1; then
      found="$prefix"
      break
    fi
  done
  [[ -n "$found" ]] || die "backup '$name' not found on $RCLONE_REMOTE:$R2_BACKUP_PATH/{daily,weekly,monthly}"
  log "Downloading $found/$name ..."
  rclone_cmd copy "$RCLONE_REMOTE:$R2_BACKUP_PATH/$found/$name" "$dest_dir/"
  rclone_cmd copy "$RCLONE_REMOTE:$R2_BACKUP_PATH/$found/$name.sha256" "$dest_dir/" 2>/dev/null || true
  echo "$dest_dir/$name"
}

#### Restore implementation ####
do_restore() {
  local archive="$1" DRY_RUN="${2:-0}"

  local extract_dir="$RESTORE_WORK_DIR/extract"
  mkdir -p "$RESTORE_WORK_DIR"
  chmod 700 "$RESTORE_WORK_DIR"
  rm -rf "$extract_dir"
  mkdir -p "$extract_dir"

  log "Extracting archive..."
  tar -xf "$archive" -C "$extract_dir"

  # Safety / space checks
  local free_bytes
  free_bytes="$(df -B1 --output=avail "$TOOLKIT_ROOT" | tail -1 | tr -d ' ')"
  log "Free space on $TOOLKIT_ROOT: $((free_bytes/1073741824)) GiB"

  if [[ "$DRY_RUN" == "1" ]]; then
    log "--- DRY RUN: nothing will be changed ---"
    log "Would restore:"
    log "  config  -> $TOOLKIT_ROOT/config"
    log "  mongodb -> mongorestore into running $MONGO_CONTAINER (db $MONGO_DB)"
    log "  redis   -> $REDIS_DATA_PATH (after stopping $REDIS_CONTAINER)"
    log "  overleaf-> $OVERLEAF_DATA_PATH/data (history/)"
    log "--- backup-info.txt ---"
    cat "$extract_dir/metadata/backup-info.txt"
    return 0
  fi

  # Safety snapshot of the current config before overwriting anything.
  local pre_dir="$RESTORE_WORK_DIR/pre-restore"
  mkdir -p "$pre_dir"
  if [[ -d "$TOOLKIT_ROOT/config" ]] && ls -A "$TOOLKIT_ROOT/config" | grep -q .; then
    tar -C "$TOOLKIT_ROOT/config" -cf "$pre_dir/config-pre-restore-$(date +%F_%H-%M-%S).tar" .
    log "Saved current config snapshot to $pre_dir"
  fi

  # 1. Stop user-facing Overleaf
  if docker inspect -f '{{.State.Running}}' "$SHARELATEX_CONTAINER" 2>/dev/null | grep -q true; then
    log "Stopping sharelatex container..."
    docker stop --time 60 "$SHARELATEX_CONTAINER" >/dev/null
  fi

  # 2. Restore toolkit configuration (contains secrets; only from an encrypted/verified archive)
  log "Restoring config/ ..."
  tar -xf "$extract_dir/config/config.tar" -C "$TOOLKIT_ROOT/config"
  log "config restored. Note: OVERLEAF_INVITE_TOKEN_SECRET will change -> users must re-login."

  # 3. Restore MongoDB
  log "Restoring MongoDB (mongorestore, dropping existing $MONGO_DB collections)..."
  docker exec "$MONGO_CONTAINER" \
    mongorestore --host=127.0.0.1 --port 27017 --gzip --archive --drop --nsInclude="$MONGO_DB.*" \
    < "$extract_dir/mongodb/dump.archive.gz"
  log "MongoDB restore OK"

  # 4. Restore Redis (requires the redis container stopped; data dir replaced)
  log "Stopping redis container..."
  docker stop "$REDIS_CONTAINER" >/dev/null 2>&1 || true
  # Validate the target before removing anything.
  local redis_target_regex="^$TOOLKIT_ROOT/data/redis$"
  [[ "$REDIS_DATA_PATH" =~ $redis_target_regex ]] || die "refusing to touch unexpected redis path: $REDIS_DATA_PATH"
  if [[ -d "$REDIS_DATA_PATH" ]]; then
    log "Replacing redis data dir contents: $REDIS_DATA_PATH"
    rm -rf "$REDIS_DATA_PATH"
  fi
  mkdir -p "$REDIS_DATA_PATH"
  tar -xf "$extract_dir/redis/redis-data.tar" -C "$REDIS_DATA_PATH"
  chown -R 999:999 "$REDIS_DATA_PATH"
  chmod 700 "$REDIS_DATA_PATH"
  log "Starting redis container..."
  docker start "$REDIS_CONTAINER" >/dev/null
  sleep 2
  docker exec "$REDIS_CONTAINER" redis-cli PING >/dev/null 2>&1 \
    || die "redis did not come back after restore"
  log "Redis restore OK"

  # 5. Restore Overleaf persistent filesystem data
  log "Restoring Overleaf filesystem data (history/) ..."
  tar -xf "$extract_dir/overleaf/overleaf-data.tar" -C "$OVERLEAF_DATA_PATH/data"
  chown -R 33:33 "$OVERLEAF_DATA_PATH/data"
  log "Overleaf filesystem restore OK"

  # 6. Restore optional git-bridge data
  if [[ "$GIT_BRIDGE_ENABLED" == "true" ]] && [[ -f "$extract_dir/git-bridge/git-bridge-data.tar" ]]; then
    local git_bridge_data
    git_bridge_data="$(realpath "$TOOLKIT_ROOT/$(toolkit_read GIT_BRIDGE_DATA_PATH)")"
    mkdir -p "$git_bridge_data"
    tar -xf "$extract_dir/git-bridge/git-bridge-data.tar" -C "$git_bridge_data"
    log "git-bridge restore OK"
  fi

  # 7. Start Overleaf
  log "Starting sharelatex container..."
  docker start "$SHARELATEX_CONTAINER" >/dev/null

  # 8. Health checks
  log "Running health checks..."
  local up=1
  docker inspect -f '{{.State.Running}}' "$MONGO_CONTAINER" | grep -q true || { log "FAIL: mongo not running"; up=0; }
  docker inspect -f '{{.State.Running}}' "$REDIS_CONTAINER" | grep -q true || { log "FAIL: redis not running"; up=0; }
  docker inspect -f '{{.State.Running}}' "$SHARELATEX_CONTAINER" | grep -q true || { log "FAIL: sharelatex not running"; up=0; }
  local port
  port="$(toolkit_read OVERLEAF_PORT)"
  sleep 20
  local code
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "http://127.0.0.1:${port}/login" || true)"
  log "Web /login HTTP status: $code"
  [[ "$code" != "000" ]] || { log "FAIL: web app did not respond"; up=0; }

  if [[ "$up" == "1" ]]; then
    log "=== Restore completed successfully ==="
    log "Manual verification still required: log in, open a project, confirm files/history are present."
  else
    die "restore completed but health checks failed"
  fi
}

#### Main dispatch ####
MODE=""
ARCHIVE=""
FROM_R2=""
DRY_RUN=0
YES=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --verify)   MODE=verify;   shift;;
    --dry-run)  MODE=restore; DRY_RUN=1; shift;;
    --archive)  ARCHIVE="$2";  shift 2;;
    --from-r2)  FROM_R2="$2";  shift 2;;
    --yes)      YES=1; shift;;
    -h|--help)  sed -n '2,16p' "$0"; exit 0;;
    *) die "unrecognised argument: $1 (use --help)";;
  esac
done

if [[ "$MODE" == "verify" ]]; then
  [[ -n "$ARCHIVE" ]] || die "--verify requires --archive FILE"
  verify_archive "$ARCHIVE"
  exit $?
fi

if [[ -z "$ARCHIVE" && -n "$FROM_R2" ]]; then
  ARCHIVE="$(fetch_from_r2 "$FROM_R2" "$RESTORE_WORK_DIR/downloads")"
fi
[[ -n "$ARCHIVE" ]] || die "no backup specified (use --archive FILE or --from-r2 NAME)"
[[ -f "$ARCHIVE" ]] || die "archive not found: $ARCHIVE"

verify_archive "$ARCHIVE"

if [[ "$DRY_RUN" == "1" ]]; then
  do_restore "$ARCHIVE" 1
  exit 0
fi

if [[ "$YES" != "1" ]]; then
  echo "WARNING: this will overwrite the current Overleaf installation at $TOOLKIT_ROOT."
  echo "Current data (config, mongo, redis, overleaf files) will be replaced."
  echo "A snapshot of the current config/ is kept under $RESTORE_WORK_DIR/pre-restore."
  read -r -p "Type YES to continue: " answer
  [[ "$answer" == "YES" ]] || die "aborted"
fi

do_restore "$ARCHIVE" 0
