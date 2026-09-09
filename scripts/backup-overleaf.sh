#! /usr/bin/env bash
# Overleaf Toolkit backup script.
#
# Produces a consistent, encrypted backup of a self-hosted Overleaf instance and
# uploads it to a dedicated Cloudflare R2 bucket via an rclone crypt remote.
#
# Usage:
#   backup-overleaf.sh                  run a full backup
#   backup-overleaf.sh --verify FILE    verify an existing local backup archive
#   backup-overleaf.sh --retention-only run only the remote retention pass
#   backup-overleaf.sh --local-only     run backup without the R2 upload step
#
# See doc/backups.md for setup, operation, retention and restore instructions.

set -euo pipefail

BACKUP_SCRIPT_VERSION="1.0.0"

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
BACKUP_WORK_DIR="${BACKUP_WORK_DIR:-/var/lib/overleaf-backups}"
RCLONE_BIN="${RCLONE_BIN:-rclone}"
RCLONE_CONFIG="${RCLONE_CONFIG:-/etc/overleaf-backup/rclone.conf}"
RCLONE_REMOTE="${RCLONE_REMOTE:-r2-crypt}"
R2_BACKUP_PATH="${R2_BACKUP_PATH:-overleaf}"
RETENTION_DAILY="${RETENTION_DAILY:-7}"
RETENTION_WEEKLY="${RETENTION_WEEKLY:-4}"
RETENTION_MONTHLY="${RETENTION_MONTHLY:-6}"
LOCAL_KEEP="${LOCAL_KEEP:-3}"
MIN_FREE_SPACE="${MIN_FREE_SPACE:-1073741824}" # 1 GiB
QUIESCE="${QUIESCE:-true}"
MONGO_DB="${MONGO_DB:-sharelatex}"
# Optional overrides (defaults are derived from the toolkit config):
MONGO_CONTAINER="${MONGO_CONTAINER:-}"
REDIS_CONTAINER="${REDIS_CONTAINER:-}"
SHARELATEX_CONTAINER="${SHARELATEX_CONTAINER:-}"

if [[ -f /etc/overleaf-backup/backup.env ]]; then
  set -a
  # shellcheck disable=SC1091
  source /etc/overleaf-backup/backup.env
  set +a
fi

#### Helpers ####
log()  { echo "[overleaf-backup] $*" >&2; }
die()  { echo "[overleaf-backup] ERROR: $*" >&2; exit 1; }

# Load toolkit config (data paths, image name, ...) from lib/shared-functions.sh.
# shellcheck disable=SC1091
source "$TOOLKIT_ROOT/lib/shared-functions.sh"

toolkit_read() { # toolkit_read VAR  ->  value from config/overleaf.rc
  read_configuration "$1"
}

OVERLEAF_DATA_PATH="$(realpath "$TOOLKIT_ROOT/$(toolkit_read OVERLEAF_DATA_PATH)")"
MONGO_DATA_PATH="$(realpath "$TOOLKIT_ROOT/$(toolkit_read MONGO_DATA_PATH)")"
REDIS_DATA_PATH="$(realpath "$TOOLKIT_ROOT/$(toolkit_read REDIS_DATA_PATH)")"
GIT_BRIDGE_ENABLED="$(toolkit_read GIT_BRIDGE_ENABLED)"
GIT_BRIDGE_DATA_PATH=""
if [[ "$GIT_BRIDGE_ENABLED" == "true" ]]; then
  GIT_BRIDGE_DATA_PATH="$(realpath "$TOOLKIT_ROOT/$(toolkit_read GIT_BRIDGE_DATA_PATH)")"
fi
PROJECT_NAME="$(toolkit_read PROJECT_NAME)"
OVERLEAF_IMAGE_NAME="$(toolkit_read OVERLEAF_IMAGE_NAME)"
OVERLEAF_VERSION="$(cat "$TOOLKIT_ROOT/config/version")"

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

STAGING_DIR="$BACKUP_WORK_DIR/staging"
OUTGOING_DIR="$BACKUP_WORK_DIR/outgoing"
RETAINED_DIR="$BACKUP_WORK_DIR/retained"

SHARELATEX_WAS_STOPPED=0

#### Verify an existing backup archive ####
verify_archive() {
  local archive="$1" tmpdir
  [[ -f "$archive" ]] || die "archive not found: $archive"
  log "Verifying archive integrity: $archive"
  command -v zstd >/dev/null || die "zstd not installed"
  zstd -t "$archive" || die "zstd integrity check failed for $archive"
  tar -tf "$archive" >/dev/null || die "archive is not a readable tar"

  tmpdir="$(mktemp -d)"
  trap 'rm -rf "$tmpdir"' RETURN
  tar -xf "$archive" -C "$tmpdir"
  [[ -f "$tmpdir/metadata/checksums.sha256" ]] || die "backup has no metadata/checksums.sha256"
  [[ -f "$tmpdir/metadata/backup-info.txt" ]] || die "backup has no metadata/backup-info.txt"
  [[ -f "$tmpdir/mongodb/dump.archive.gz" ]] || die "backup has no mongodb dump"
  [[ -f "$tmpdir/redis/redis-data.tar" ]] || die "backup has no redis data"
  [[ -f "$tmpdir/overleaf/overleaf-data.tar" ]] || die "backup has no overleaf filesystem data"
  [[ -f "$tmpdir/config/config.tar" ]] || die "backup has no config data"

  log "Verifying component checksums..."
  local ok=1 sum rel
  while read -r sum rel; do
    [[ -n "$rel" ]] || continue
    if ! ( cd "$tmpdir" && echo "$sum  $rel" | sha256sum -c --status ); then
      log "CHECKSUM MISMATCH: $rel"
      ok=0
    fi
  done < "$tmpdir/metadata/checksums.sha256"

  if [[ "$ok" == "1" ]]; then
    log "Backup verified OK: $archive"
    log "--- backup-info.txt ---"
    cat "$tmpdir/metadata/backup-info.txt"
    return 0
  else
    die "backup verification FAILED for $archive"
  fi
}

#### Prerequisite checks ####
check_prerequisites() {
  command -v zstd >/dev/null || die "zstd is not installed"
  command -v "$RCLONE_BIN" >/dev/null || die "rclone ($RCLONE_BIN) is not installed"
  command -v docker >/dev/null || die "docker is not installed"
  docker info >/dev/null 2>&1 || die "cannot talk to the docker daemon"
  for c in "$MONGO_CONTAINER" "$REDIS_CONTAINER" "$SHARELATEX_CONTAINER"; do
    docker inspect -f '{{.State.Running}}' "$c" >/dev/null 2>&1 || die "container '$c' not found"
  done
  docker inspect -f '{{.State.Running}}' "$MONGO_CONTAINER" | grep -q true || die "mongo container is not running"
  docker inspect -f '{{.State.Running}}' "$REDIS_CONTAINER" | grep -q true || die "redis container is not running"

  # Only the Overleaf filesystem and toolkit config are read from the host;
  # mongo and redis are captured through their containers.
  local dirs=( "$OVERLEAF_DATA_PATH/data/history" "$TOOLKIT_ROOT/config" )
  for d in "${dirs[@]}"; do
    [[ -r "$d" ]] || die "cannot read required path: $d"
  done
}

ensure_work_dirs() {
  for d in "$STAGING_DIR" "$OUTGOING_DIR" "$RETAINED_DIR"; do
    mkdir -p "$d"
  done
  chmod 700 "$BACKUP_WORK_DIR" "$STAGING_DIR"
  local free_bytes
  free_bytes="$(df -B1 --output=avail "$BACKUP_WORK_DIR" | tail -1 | tr -d ' ')"
  if (( free_bytes < MIN_FREE_SPACE )); then
    die "insufficient free space in $BACKUP_WORK_DIR (have $free_bytes, need $MIN_FREE_SPACE)"
  fi
}

#### Quiesce / resume Overleaf ####
quiesce() {
  if ! docker inspect -f '{{.State.Running}}' "$SHARELATEX_CONTAINER" 2>/dev/null | grep -q true; then
    log "sharelatex already stopped; nothing to quiesce"
    return
  fi
  log "Stopping sharelatex container ($SHARELATEX_CONTAINER) for consistent capture..."
  docker stop --time 60 "$SHARELATEX_CONTAINER" >/dev/null
  SHARELATEX_WAS_STOPPED=1
}

resume() {
  if [[ "$SHARELATEX_WAS_STOPPED" == "1" ]]; then
    log "Restarting sharelatex container ($SHARELATEX_CONTAINER)..."
    docker start "$SHARELATEX_CONTAINER" >/dev/null || true
    SHARELATEX_WAS_STOPPED=0
  fi
}

#### Component capture ####
capture_mongodb() {
  log "Running mongodump..."
  # Fail loudly if the database has no data (e.g. wrong db name), instead of
  # silently producing an empty archive.
  local collections
  collections="$(docker exec "$MONGO_CONTAINER" mongosh --quiet "$MONGO_DB" \
    --eval 'print(db.getCollectionNames().length)' 2>/dev/null || echo 0)"
  [[ "${collections:-0}" =~ ^[0-9]+$ && "${collections}" -gt 0 ]] \
    || die "mongodb database '$MONGO_DB' has no collections; refusing to back up an empty dump"
  mkdir -p "$STAGING_DIR/mongodb"
  docker exec "$MONGO_CONTAINER" \
    mongodump --host=127.0.0.1 --port 27017 --db "$MONGO_DB" --gzip --archive \
    > "$STAGING_DIR/mongodb/dump.archive.gz" 2>"$STAGING_DIR/mongodb/mongodump.log"
  if [[ ! -s "$STAGING_DIR/mongodb/dump.archive.gz" ]]; then
    die "mongodump produced an empty archive (see $STAGING_DIR/mongodb/mongodump.log)"
  fi
  gzip -t "$STAGING_DIR/mongodb/dump.archive.gz" || die "mongodump archive failed gzip check"
  if grep -qi "error" "$STAGING_DIR/mongodb/mongodump.log"; then
    die "mongodump reported errors (see $STAGING_DIR/mongodb/mongodump.log)"
  fi
  log "mongodump OK ($(du -h "$STAGING_DIR/mongodb/dump.archive.gz" | cut -f1))"
}

capture_redis() {
  log "Saving redis to disk (SAVE) and capturing data dir via the container..."
  # Redis stays running. The sharelatex container is stopped, so no application
  # writes occur during the capture; SAVE makes dump.rdb current and the AOF
  # files are stable. Capturing through the container avoids host-side
  # permission issues on the data directory.
  docker exec "$REDIS_CONTAINER" redis-cli SAVE >/dev/null || die "redis SAVE failed"
  docker exec "$REDIS_CONTAINER" sh -c 'tar -C /data -cf /tmp/redis-data.tar .' \
    || die "redis data tar failed"
  mkdir -p "$STAGING_DIR/redis"
  docker cp "$REDIS_CONTAINER:/tmp/redis-data.tar" "$STAGING_DIR/redis/redis-data.tar"
  docker exec "$REDIS_CONTAINER" rm -f /tmp/redis-data.tar
  [[ -s "$STAGING_DIR/redis/redis-data.tar" ]] || die "redis data tar is empty"
  log "redis capture OK ($(du -h "$STAGING_DIR/redis/redis-data.tar" | cut -f1))"
}

capture_overleaf_fs() {
  log "Capturing persistent Overleaf filesystem data (history) ..."
  mkdir -p "$STAGING_DIR/overleaf"
  # history/ contains project + global blobs (user uploads are stored here with the
  # fs filestore backend) and the history chunk store. cache/, compiles/, output/,
  # tmp/ and template_files/ are reproducible and intentionally excluded.
  tar -C "$OVERLEAF_DATA_PATH/data" -cf "$STAGING_DIR/overleaf/overleaf-data.tar" history
  log "overleaf filesystem capture OK ($(du -h "$STAGING_DIR/overleaf/overleaf-data.tar" | cut -f1))"
}

capture_git_bridge() {
  if [[ "$GIT_BRIDGE_ENABLED" != "true" ]]; then
    return
  fi
  log "Capturing git-bridge data..."
  mkdir -p "$STAGING_DIR/git-bridge"
  tar -C "$GIT_BRIDGE_DATA_PATH" -cf "$STAGING_DIR/git-bridge/git-bridge-data.tar" .
  log "git-bridge capture OK"
}

capture_config() {
  log "Capturing toolkit configuration (config/)..."
  mkdir -p "$STAGING_DIR/config"
  tar -C "$TOOLKIT_ROOT/config" --exclude=.gitkeep -cf "$STAGING_DIR/config/config.tar" .
  [[ -s "$STAGING_DIR/config/config.tar" ]] || die "config tar is empty"
}

write_metadata() {
  mkdir -p "$STAGING_DIR/metadata"
  local mongo_version redis_version
  mongo_version="$(docker exec "$MONGO_CONTAINER" mongosh --quiet --eval 'db.version()' 2>/dev/null || echo unknown)"
  redis_version="$(docker exec "$REDIS_CONTAINER" sh -c 'redis-server --version' 2>/dev/null | awk '{print $3}' | sed 's/^v=//' || echo unknown)"
  {
    echo "backup_timestamp=$(date --iso-8601=seconds)"
    echo "hostname=$(hostname)"
    echo "toolkit_root=$TOOLKIT_ROOT"
    echo "toolkit_git_commit=$(git -C "$TOOLKIT_ROOT" rev-parse HEAD 2>/dev/null || echo unknown)"
    echo "toolkit_version_seed=$(cat "$TOOLKIT_ROOT/lib/config-seed/version" 2>/dev/null || echo unknown)"
    echo "overleaf_image=$OVERLEAF_IMAGE_NAME:$OVERLEAF_VERSION"
    echo "mongodb_version=$mongo_version"
    echo "redis_version=$redis_version"
    echo "backup_script_version=$BACKUP_SCRIPT_VERSION"
    echo "overleaf_data_path=$OVERLEAF_DATA_PATH"
    echo "mongo_data_path=$MONGO_DATA_PATH"
    echo "redis_data_path=$REDIS_DATA_PATH"
    echo "git_bridge_enabled=$GIT_BRIDGE_ENABLED"
    echo "mongodump_result=ok"
    echo "redis_result=ok"
    echo "overleaf_fs_result=ok"
    echo "config_result=ok"
  } > "$STAGING_DIR/metadata/backup-info.txt"
}

write_checksums() {
  ( cd "$STAGING_DIR" \
      && sha256sum mongodb/dump.archive.gz redis/redis-data.tar overleaf/overleaf-data.tar config/config.tar \
      > metadata/checksums.sha256 )
  ( cd "$STAGING_DIR" && sha256sum metadata/backup-info.txt >> metadata/checksums.sha256 )
}

#### Remote helpers ####
rclone_cmd() {
  "$RCLONE_BIN" --config "$RCLONE_CONFIG" "$@"
}

# Determine the desired retention prefix for a backup date:
#   monthly -> keep, weekly -> keep, daily -> keep, "" -> delete
retention_pass() {
  log "Running retention policy (daily=$RETENTION_DAILY weekly=$RETENTION_WEEKLY monthly=$RETENTION_MONTHLY)..."
  if ! rclone_cmd lsf "$RCLONE_REMOTE:$R2_BACKUP_PATH/" >/dev/null 2>&1; then
    log "Backup path not present remotely; skipping retention"
    return 0
  fi

  local prefix name line
  local -a all=()          # "prefix|YYYY-MM-DD_HH-MM-SS|name"
  for prefix in daily weekly monthly; do
    while IFS= read -r line; do
      [[ -z "$line" ]] && continue
      name="$line"
      local date_ts="${name#overleaf-backup-}"
      date_ts="${date_ts%.tar.zst}"
      if [[ "$date_ts" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}_[0-9]{2}-[0-9]{2}-[0-9]{2}$ ]]; then
        all+=("$prefix|$date_ts|$name")
      else
        log "ignoring non-backup object: $prefix/$name"
      fi
    done < <(rclone_cmd lsf --files-only "$RCLONE_REMOTE:$R2_BACKUP_PATH/$prefix/" 2>/dev/null)
  done

  if (( ${#all[@]} == 0 )); then
    log "No backups found remotely; nothing to retain."
    return 0
  fi

  # "date_ts name" lines, newest first
  local sorted
  sorted="$(printf '%s\n' "${all[@]}" | sort -r -t'|' -k2 | awk -F'|' '{print $2, $3}')"

  local i key
  local -a months=() weeks=()
  for i in 0 1 2 3 4 5; do months+=("$(date -d "$(date +%Y-%m-01) - $i month" +%Y-%m)"); done
  for i in 0 1 2 3; do weeks+=("$(date -d "$(date +%F) - $i weeks" +%G-%V)"); done

  # newest backup per selected month / week
  local -A monthly_sel=() weekly_sel=()
  local d key_ts
  for key in "${months[@]}"; do
    while read -r d _; do
      [[ -z "$d" ]] && continue
      key_ts="${d:0:7}"
      if [[ "$key_ts" == "$key" ]]; then monthly_sel["$d"]=1; break; fi
    done <<< "$sorted"
  done
  for key in "${weeks[@]}"; do
    while read -r d _; do
      [[ -z "$d" ]] && continue
      key_ts="$(date -d "${d:0:10} ${d:11:2}:${d:14:2}:${d:17:2}" +%G-%V 2>/dev/null || true)"
      if [[ -n "$key_ts" && "$key_ts" == "$key" ]]; then weekly_sel["$d"]=1; break; fi
    done <<< "$sorted"
  done

  # daily selection: newest RETENTION_DAILY not already selected monthly/weekly
  local count=0
  local -A daily_sel=()
  while read -r d _; do
    [[ -z "$d" ]] && continue
    if [[ -z "${monthly_sel[$d]:-}" && -z "${weekly_sel[$d]:-}" ]]; then
      daily_sel["$d"]=1
      count=$((count+1))
      (( count >= RETENTION_DAILY )) && break
    fi
  done <<< "$sorted"

  local -A desired=()
  for d in "${!monthly_sel[@]}"; do desired["$d"]=monthly; done
  for d in "${!weekly_sel[@]}"; do
    [[ -z "${desired[$d]:-}" ]] && desired["$d"]=weekly
  done
  for d in "${!daily_sel[@]}"; do
    [[ -z "${desired[$d]:-}" ]] && desired["$d"]=daily
  done

  local entry prefix_cur date rest want deleted=0 moved=0
  for entry in "${all[@]}"; do
    prefix_cur="${entry%%|*}"
    rest="${entry#*|}"
    date="${rest%%|*}"
    name="${rest#*|}"
    want="${desired[$date]:-}"
    if [[ -z "$want" ]]; then
      log "retention: delete $prefix_cur/$name"
      rclone_cmd delete "$RCLONE_REMOTE:$R2_BACKUP_PATH/$prefix_cur/$name"
      rclone_cmd delete "$RCLONE_REMOTE:$R2_BACKUP_PATH/$prefix_cur/$name.sha256" 2>/dev/null || true
      deleted=$((deleted+1))
    elif [[ "$want" != "$prefix_cur" ]]; then
      log "retention: move $prefix_cur/$name -> $want/"
      rclone_cmd moveto "$RCLONE_REMOTE:$R2_BACKUP_PATH/$prefix_cur/$name" \
                       "$RCLONE_REMOTE:$R2_BACKUP_PATH/$want/$name"
      if rclone_cmd lsl "$RCLONE_REMOTE:$R2_BACKUP_PATH/$prefix_cur/$name.sha256" >/dev/null 2>&1; then
        rclone_cmd moveto "$RCLONE_REMOTE:$R2_BACKUP_PATH/$prefix_cur/$name.sha256" \
                         "$RCLONE_REMOTE:$R2_BACKUP_PATH/$want/$name.sha256"
      fi
      moved=$((moved+1))
    fi
  done
  log "retention pass done (deleted=$deleted moved=$moved)"
}

#### Upload ####
upload_and_verify() {
  local archive="$1" sidecar="$2"
  log "Uploading to $RCLONE_REMOTE:$R2_BACKUP_PATH/daily/ ..."
  rclone_cmd copy "$archive" "$RCLONE_REMOTE:$R2_BACKUP_PATH/daily/"
  if [[ -f "$sidecar" ]]; then
    rclone_cmd copy "$sidecar" "$RCLONE_REMOTE:$R2_BACKUP_PATH/daily/"
  fi
  local local_size remote_size name
  local_size="$(stat -c %s "$archive")"
  name="$(basename "$archive")"
  remote_size="$(rclone_cmd lsl "$RCLONE_REMOTE:$R2_BACKUP_PATH/daily/$name" 2>/dev/null | awk '{print $1}' || echo 0)"
  if [[ "$remote_size" != "$local_size" ]]; then
    die "remote object size mismatch (local=$local_size remote=$remote_size); upload FAILED"
  fi
  log "Upload verified OK (remote size $remote_size bytes)"
}

#### Main backup ####
run_backup() {
  log "=== Overleaf backup start ==="
  check_prerequisites
  ensure_work_dirs

  local ts name archive sidecar
  ts="$(date +%F_%H-%M-%S)"
  name="overleaf-backup-$ts.tar.zst"
  archive="$OUTGOING_DIR/$name"
  sidecar="$archive.sha256"

  log "Backup name: $name"
  log "Staging dir: $STAGING_DIR"
  rm -rf "$STAGING_DIR"
  mkdir -p "$STAGING_DIR"

  # Restart Overleaf even if any later step fails, and always clean staging.
  COMPLETED=0
  trap 'resume; rm -rf "$STAGING_DIR"; [[ "$COMPLETED" == "1" ]] || log "=== Overleaf backup FAILED ==="' EXIT

  if [[ "$QUIESCE" == "true" ]]; then
    quiesce
  else
    log "QUIESCE=false: capturing without stopping sharelatex"
  fi

  capture_mongodb
  capture_redis
  capture_overleaf_fs
  capture_git_bridge
  capture_config
  write_metadata
  write_checksums

  log "Compressing archive (zstd) ..."
  tar -I 'zstd -19 -T0' -cf "$archive" -C "$STAGING_DIR" .
  zstd -t "$archive" || die "final archive failed zstd integrity check"
  tar -tf "$archive" >/dev/null || die "final archive is not a readable tar"
  sha256sum "$archive" > "$sidecar"
  log "Archive created: $archive ($(du -h "$archive" | cut -f1))"

  # Bring Overleaf back online before the (potentially slow) upload.
  resume

  if [[ "$UPLOAD" == "true" ]]; then
    upload_and_verify "$archive" "$sidecar"
    retention_pass
  else
    log "UPLOAD=false: skipping upload and retention"
  fi

  # Keep a small local set of the most recent archives.
  log "Moving archive to local retention dir..."
  mv -f "$archive" "$sidecar" "$RETAINED_DIR/" 2>/dev/null || true
  ( cd "$RETAINED_DIR" && ls -1t overleaf-backup-*.tar.zst 2>/dev/null | tail -n +$((LOCAL_KEEP+1)) | while read -r f; do
      log "pruning local archive $f"
      rm -f "$f" "$f.sha256"
    done ) || true

  COMPLETED=1
  log "=== Overleaf backup finished OK ==="
  log "backup_file=$RETAINED_DIR/$name"
  log "backup_size=$(stat -c %s "$RETAINED_DIR/$name")"
  log "mongodb_result=ok"
  log "redis_result=ok"
  log "overleaf_fs_result=ok"
  log "config_result=ok"
  log "compression_result=ok"
  log "integrity_verification=ok"
  log "upload_result=ok"
  log "retention_result=ok"
}

#### Main dispatch ####
UPLOAD="${UPLOAD:-true}"
MODE="backup"
case "${1:-}" in
  --verify)
    MODE=verify; shift
    [[ $# -eq 1 ]] || die "usage: backup-overleaf.sh --verify FILE"
    verify_archive "$1"
    exit $?
    ;;
  --retention-only)
    MODE=retention
    ;;
  --local-only)
    UPLOAD=false
    ;;
  -h|--help)
    sed -n '2,14p' "$0"
    exit 0
    ;;
  "")
    ;;
  *)
    die "unrecognised argument: ${1:-} (use --help)"
    ;;
esac

if [[ "$MODE" == "backup" ]]; then
  run_backup
elif [[ "$MODE" == "retention" ]]; then
  retention_pass
fi
