# Overleaf Backups (Cloudflare R2)

Automated, encrypted backups for this self-hosted Overleaf instance, with a tested
restore path. Backups are created locally, encrypted client-side with
`rclone crypt`, and uploaded to a dedicated **Cloudflare R2** bucket in the EU
location.

## What is backed up

| Component | Method | Notes |
|---|---|---|
| MongoDB | `mongodump --gzip --archive` against the running `mongo` container | All Overleaf metadata, users, projects, docs. Dump verified non-empty before continuing. |
| Redis | `redis-cli SAVE` then tar of the data dir **via the running container** | Captures `dump.rdb` + AOF (`appendonlydir`) consistently; app is quiesced so no writes occur. |
| Overleaf filesystem | tar of `data/overleaf/data/history/` | Contains project/global blobs (user file uploads with the `fs` filestore backend) and the history chunk store. |
| Toolkit config | tar of `config/` | `overleaf.rc`, `variables.env` (incl. the invite-token secret), `version`, `docker-compose.override.yml`. |
| git-bridge | tar of its data dir | Only when `GIT_BRIDGE_ENABLED=true` (disabled here). |

### Excluded (reproducible/ephemeral)

`data/overleaf/data/{cache,compiles,output,template_files}`, `data/overleaf/tmp/`,
`data/public-build` (regenerate with `bin/build-frontend`), mongo/redis live data
directories (never copied raw), and the `redis-cache-1` container (unrelated to
this instance).

## Consistency

The `sharelatex` container is stopped for the duration of the capture
(typically ~20-60 s). `mongodump`, redis save/tar, and the filesystem tar are
then produced from a quiesced system, giving a single consistent point in time.
Overleaf is restarted **before** the R2 upload so upload time does not add
downtime. Set `QUIESCE=false` in `backup.env` to skip the stop (weaker
consistency — not recommended).

## Backup format

Timestamped archives compressed with `zstd`:

```
overleaf-backup-2026-09-09_03-00-00.tar.zst
```

Internal layout:

```
├── metadata/
│   ├── backup-info.txt     # timestamp, hostname, versions, paths (no secrets)
│   └── checksums.sha256    # sha256 of each component
├── mongodb/dump.archive.gz
├── redis/redis-data.tar
├── overleaf/overleaf-data.tar
└── config/config.tar
```

Each upload also ships a `<archive>.sha256` sidecar. Both live in the encrypted
remote.

## Retention

Policy (configurable): **7 daily, 4 weekly, 6 monthly** distinct restore points.
The retention pass runs after every upload, **only inside the dedicated bucket
path** (`r2-crypt:overleaf/`):

1. **Monthly**: newest backup of each of the last 6 calendar months → `monthly/`.
2. **Weekly**: newest backup of each of the last 4 ISO weeks → `weekly/`.
3. **Daily**: 7 newest remaining → `daily/`; everything else deleted.

Each archive exists in exactly one prefix (moved, never duplicated). Remote
layout: `overleaf/{daily,weekly,monthly}/`.

## Setup

### 1. Cloudflare R2 bucket (EU location)

1. In Cloudflare, create a bucket named e.g. `overleaf-backups`. **Location: EU**
   (VPS is in Germany). Buckets created via the dashboard default to APAC unless
   you pick EU.
   - CLI alternative (region `auto` is required for R2):
     ```
     aws s3api create-bucket \
       --endpoint-url https://<ACCOUNT_ID>.r2.cloudflarestorage.com \
       --bucket overleaf-backups --region auto \
       --create-bucket-configuration LocationConstraint=EU
     ```
2. Create an **API Token** (R2 → Manage R2 API Tokens) scoped to **only this
   bucket**, with `Object Read` and `Object Write`. Do not reuse credentials from
   other applications, and give the token no access to any other bucket.

### 2. Install rclone and zstd

```
sudo dnf install rclone zstd      # Fedora
sudo apt install rclone zstd      # Debian/Ubuntu
```

### 3. Configure rclone + secrets

Run as root:

```
sudo scripts/setup-r2.sh
```

It prompts for the R2 account ID and the bucket-scoped access/secret keys, then
writes:

- `/etc/overleaf-backup/rclone.conf` (chmod 600) with two remotes:
  - `r2:` — the Cloudflare R2 S3 backend for the dedicated bucket
  - `r2-crypt:` — `crypt` remote layered over it (encrypts names + contents)
- `/etc/overleaf-backup/backup.env` (chmod 600) from
  `scripts/backup.env.example`

Verify connectivity:

```
sudo rclone --config /etc/overleaf-backup/rclone.conf lsd r2-crypt:
```

Nothing secret is committed to git. `/etc/overleaf-backup/` is root-only.

### 4. Install the systemd timer

```
sudo scripts/install-systemd.sh
```

Installs `overleaf-backup.service` + `overleaf-backup.timer` (daily at 03:00,
with `Persistent=true` and a 10 min random delay) and enables the timer.

## Operation

| Task | Command |
|---|---|
| Run a backup now | `sudo scripts/backup-overleaf.sh` |
| View backup logs | `journalctl -u overleaf-backup -e` |
| Timer status / next run | `systemctl list-timers overleaf-backup.timer` |
| Enable / disable scheduling | `systemctl enable --now overleaf-backup.timer` / `systemctl disable --now overleaf-backup.timer` |
| List backups on R2 | `sudo rclone --config /etc/overleaf-backup/rclone.conf lsf -R r2-crypt:overleaf/` |
| Verify a local archive | `sudo scripts/backup-overleaf.sh --verify <archive>` |
| Retention only | `sudo scripts/backup-overleaf.sh --retention-only` |

The daily log records start/stop times, backup name and size, and one result
line each for mongodump, redis, filesystem, config, compression, integrity,
upload and retention. Failures exit non-zero (journalctl shows `Result: exit-code`).

## Restore

### Disaster recovery on a fresh VPS

1. Install Docker + this toolkit, clone the repo:
   ```
   git clone <repo> overleaf-toolkit && cd overleaf-toolkit
   bin/init
   ```
2. Install rclone/zstd and recreate the secrets (or copy
   `/etc/overleaf-backup/` from the old host):
   ```
   sudo scripts/setup-r2.sh
   ```
3. Regenerate the reproducible frontend build (custom themes):
   ```
   bin/build-frontend
   ```
4. Start an empty stack (mongo/redis must be running for the restore):
   ```
   bin/up -d
   ```
5. Restore from the encrypted R2 backup (list names first if unsure):
   ```
   sudo scripts/restore-overleaf.sh --from-r2 overleaf-backup-YYYY-MM-DD_HH-MM-SS.tar.zst --yes
   ```
   or from a local archive:
   ```
   sudo scripts/restore-overleaf.sh --archive /path/to/overleaf-backup-....tar.zst --yes
   ```

The restore script: verifies the archive (zstd, structure, per-component SHA-256),
stops `sharelatex`, restores `config/`, runs `mongorestore --drop` into the
running mongo, replaces the redis data dir (redis restarted, ownership fixed),
extracts the Overleaf filesystem (ownership fixed), starts `sharelatex`, then
health-checks mongo/redis/web. A snapshot of the pre-restore `config/` is kept
under `/var/lib/overleaf-backups/restore/pre-restore/`.

### Safe-checking before a restore

```
# verify a local archive without touching the instance
sudo scripts/restore-overleaf.sh --verify --archive <archive>

# see exactly what a restore would do (downloads + extracts, changes nothing)
sudo scripts/restore-overleaf.sh --dry-run --from-r2 <name>
```

`--yes` is mandatory for a real restore; without it the script prompts for
confirmation.

### After restore (manual checks)

1. `docker ps` — `sharelatex`, `mongo`, `redis` all up.
2. `curl -I http://127.0.0.1:6778/login` returns 200.
3. Log in, open a project, and confirm files/history are present and compile.
4. Check `/admin` users/projects listing if applicable.

Note: restoring `config/variables.env` changes `OVERLEAF_INVITE_TOKEN_SECRET`,
so all existing sessions are invalidated and users must log in again.

## Security notes

- R2 bucket is private; API token is scoped to that bucket only.
- Archives are encrypted client-side (`rclone crypt`) before upload; filenames
  are encrypted too.
- Backup scripts run from the host, never inside the Overleaf containers.
- Secrets (`rclone.conf`, `backup.env`) live in root-only
  `/etc/overleaf-backup/` and are never committed or logged.
- Retention deletion is limited to `r2-crypt:overleaf/` — it cannot affect
  other buckets or paths.

## Cost / size

Backups contain only MongoDB, a small Redis dump, `history/` blobs and config —
no compiles/caches/tmps. `zstd -19` keeps the archive small. R2 charges for
storage + class-A/B operations only; ~17 objects retained plus monthly growth.
