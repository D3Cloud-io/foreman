# Backup and restore

ADR-007: **the database dump is the only escape hatch.** After the cutover there is no markdown
mirror behind Foreman, so this file is the entire recovery story for anything created in it.

## What runs on its own

| Job | When | Idempotency key |
|---|---|---|
| `backup` | nightly | `backup:<YYYY-MM-DD>` |
| `restore-drill` | weekly | `restore-drill:<ISO week>` |

Both are scheduled by the worker on its idle tick rather than by cron. The key carries the date, so
asking every minute enqueues one job — and a worker started at noon still gets that day's run,
where a timer firing "every 24 hours" skips a day on every restart.

Dumps land in `BACKUP_DIR` (`/backups` in the image, a Docker volume) as
`foreman-<timestamp>.sql.gz`, and anything older than `BACKUP_RETENTION_DAYS` is pruned by the
last stage of the same job.

### The blobs (FRM-REQ-202)

Uploaded images and source files are files under `FOREMAN_BLOB_DIR` (`/blobs`, its own Docker
volume), named by their SHA-256, with a `blob` row in the database. **The dump holds the rows and
never the bytes**, so a dump alone restores a database whose blobs point at nothing. A backup set is
therefore a pair, side by side in `BACKUP_DIR`:

```text
/backups/foreman-2026-10-19T03-00-00.sql.gz     the database
/backups/foreman-2026-10-19T03-00-00.blobs/     every file from /blobs, same names
```

The `backup` job has three stages: `dump`, `blobs`, `prune`.

- **`blobs`** runs after the dump and copies the blob directory into the paired `.blobs/` directory.
  Blobs are immutable, so files already in the previous set are **hardlinked** rather than copied
  (a nightly set costs only what was uploaded since); where a link is impossible the file is copied.
  The set is written as `<stamp>.blobs.partial` and renamed when complete, so a copy that dies
  half-way is never mistaken for a whole one. The store's own `.tmp-*` files are ignored.
- A missing or empty `FOREMAN_BLOB_DIR` is fine: the set is empty and the stage's output says
  `"empty": true, "total": 0`. Zero on a deployment that has uploads is the thing to notice.
- **`prune`** removes a dump's `.blobs/` with the dump, and any `.partial` or unpaired `.blobs/`.
  Hardlinks mean pruning an old set never damages a newer one.

## Taking one now

```bash
docker compose exec server node dist/cli/run-job.js backup
```

It refuses a dump under 1 KiB. A dump that small restored nothing, and catching it here — where the
fix is cheap — beats finding out during a restore, where it is not.

## The drill

`FRM-REQ-145` is satisfied by **performing** a restore, not by writing this file. Bindery's own code
review found a restore drill "verified by grepping" rather than by running; that finding is free to
inherit.

```bash
docker compose exec server node dist/cli/run-job.js restore-drill
```

The job creates a scratch database, restores the newest dump into it, **queries it**, and drops it
in a `finally` — so a failed drill leaves nothing behind to fill the disk it was protecting.

### What it checks about blobs (FRM-REQ-203)

After the restore, the drill reads **every row of the `blob` table from the scratch database** and
checks it against the newest dump's paired `.blobs/` directory: the file exists, and the SHA-256 of
its bytes equals its name. Existence alone would pass a truncated copy, so every file is hashed.

- **It fails** if any row has no file or a file that does not hash to its name, naming the first few
  shas and the counts (`2 of 40 blobs missing: …`). It also fails if the set holds a file whose
  name is not a SHA-256, since nothing writes those.
- **It does not fail** on a well-formed file that no row names (an upload that died between the
  file and its row leaves one). It reports the number as `unreferenced`.
- **On success** the stage output carries `blobs` (rows checked) and `verified` (rows that passed);
  they are equal, or the drill would have failed.
- A dump taken before blobs were backed up has no paired directory: with zero blob rows it passes,
  with any it fails as missing, which is the truth.

## Restoring for real

The drill proves the dump is readable. This is what you do when you actually need it.

```bash
# 1. A clean database beside the live one.
docker compose exec postgres psql -U foreman -d postgres -c 'create database foreman_restored'

# 2. The newest dump into it. ON_ERROR_STOP, or a half-restore looks like a success.
docker compose exec server sh -c \
  'gunzip -c /backups/$(ls -t /backups | head -1) \
   | psql "postgresql://foreman:foreman@postgres:5432/foreman_restored" -v ON_ERROR_STOP=1'

# 3. Check it holds what you expect before you trust it.
docker compose exec postgres psql -U foreman -d foreman_restored \
  -tAc "select count(*) from project"

# 4. Boot the app against it on a spare port and log in.
docker compose exec -e DATABASE_URL=postgresql://foreman:foreman@postgres:5432/foreman_restored \
  -e PORT=3299 server node dist/index.js
```

Then point `DATABASE_URL` at the restored database and restart the stack.

**The blobs are a separate copy.** Restore the files that pair with the dump you used. With the
stack stopped, or at least with no uploads in flight:

```bash
# 5. Copy the paired set back into the blobs volume. Same basename as the dump you restored.
docker compose exec server sh -c \
  'cp -n /backups/foreman-<timestamp>.blobs/* /blobs/'

# 6. Check them the way the drill does: every blob row has a file whose hash is its name.
docker compose exec server node dist/cli/run-job.js restore-drill
```

`cp -n` never overwrites: a name is the hash of its bytes, so a file already there is already
right. If the volume is new and the container cannot write it, `/blobs` must be owned by `node`.

## Performed on 2026-09-18

Not a description of what would happen — what did:

```console
$ docker compose exec server node dist/cli/run-job.js backup
  dump: succeeded
    {"path":"/backups/foreman-2026-09-18T18-57-37.sql.gz","bytes":169064}
  prune: succeeded
backup: succeeded

$ docker compose exec server node dist/cli/run-job.js restore-drill
  restore: succeeded
    {"dump":"foreman-2026-09-18T18-57-37.sql.gz","verifiedAt":"2026-09-18T18:57:40.350Z"}
restore-drill: succeeded
```

And the full path, restored into a clean database with the app booted against it:

```console
projects=2
users=1
login status: 200 {"status":"signed_in"}
session: 200 {"authenticated":true,"user":{"email":"dev@localhost", ...}}
```

The scratch and restored databases were dropped afterwards.

## What breaks it

- **`pg_dump` not on `PATH`.** The server image installs `postgresql-client-16`; a developer's Mac
  usually has neither, which is why the integration tests skip these on a host without them and CI
  runs them in the image.
- **A version mismatch.** `pg_dump` from a client older than the server refuses. The image pins the
  major version to the one Compose runs.
- **A dump taken as a role that no longer exists.** `--no-owner --no-privileges` is why this does
  not happen: a dump that can only be restored as the role that made it is a dump that fails on the
  day it is needed, on a fresh host.
