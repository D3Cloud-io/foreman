# Deploying

One origin, no host ports, behind a Cloudflare Tunnel. The server serves the built console as
statics, so there is one process to deploy and one certificate to care about.

## What runs

| Service | What it is |
|---|---|
| `server` | Express API + the built console. Runs migrations on boot. |
| `worker` | Job queue drain: ingest, attribution, reconcile, backup, restore drill. |
| `postgres` | PostgreSQL 16. The only stateful thing. |

The worker runs **no migrations** — the server owns the schema, so two processes never race to
change it.

## The standing rule

After every push to production, report **the commit SHA per image and the schema revision**. Both,
because "what is deployed" has two answers and the interesting failures are when they disagree — an
image rolled back over a migration that was not.

```bash
docker compose ps --format '{{.Service}} {{.Image}}'
curl -s https://foreman.d3cloud.io/health | jq '{schemaRevision, oidcReachable}'
```

`/health` is the deploy probe and answers JSON. The console's health *screen* is at `/system` —
they are different things, and a request to `/health` never reaches the SPA.

## Where it runs

`/DATA/foreman` on the Zima, behind its own Cloudflare Tunnel. That directory holds the host's own
copy of the stack — it is **not** a checkout of this repo:

| File | What |
|---|---|
| `docker-compose.yml` | The stack, pinned to image tags rather than building |
| `docker-compose.tunnel.yml` | The cloudflared container |
| `postgres.env` | `POSTGRES_PASSWORD`, and nothing else |
| `server.env` | Everything the server and worker read |
| `tunnel.env` | `TUNNEL_TOKEN` |

Two deliberate differences from the compose file in this repo:

- **Images, not builds.** CI publishes `ghcr.io/d3cloud-io/foreman/{server,worker}` tagged by long
  SHA, from `main`, once the whole gate is green.
- **No `${...}` interpolation anywhere.** ZimaOS parses compose files with its own loader, which
  does not read `.env`. One unresolved variable makes the whole stack fail to load, and it then
  appears in the dashboard as anonymous container tiles rather than one Foreman app. This is why
  the image tag is written out literally and every secret arrives through an `env_file`.

The tunnel is **remotely managed**: its ingress (`foreman.d3cloud.io` → `http://server:3200`) lives
in Cloudflare, not in a file on the host, so the container needs only its token.

## Deploying

CI builds the artifact; it does not ship it. Deploying is a deliberate act on the host:

```bash
ssh root@<zima-lan-ip>
cd /DATA/foreman
# Edit both image: lines to the new sha-<40 hex> tag, then:
export DOCKER_CONFIG=/DATA/.docker
docker compose -f docker-compose.yml -f docker-compose.tunnel.yml pull
docker compose -f docker-compose.yml -f docker-compose.tunnel.yml up -d --wait
```

`DOCKER_CONFIG` is needed because the host's default config path is not writable.

`--wait` blocks until every healthcheck passes. The server's is `node dist/healthcheck.js`; the
worker's checks that its heartbeat file was touched in the last two minutes, which is the only way
to tell a drained queue from a dead worker.

Migrations run on the server's boot, before it serves. A migration that fails stops the boot, and
the old container keeps serving — which is the behaviour to want.

## Rolling back

Put the previous SHA back in the two `image:` lines and bring it up again.

**Migrations do not roll back.** If the release included one, restore from the dump taken before it
instead — see [backup-restore.md](backup-restore.md). This is the case the standing rule exists to
make visible: an image at an old SHA against a schema at a new revision is not a rollback, it is a
combination nobody has tested.

## Configuration

In development everything comes from `.env`, except the two things Compose sets itself:

- `DATABASE_URL` — inside the network the database is `postgres:5432`, not the host's port.
- `BACKUP_DIR` — `/backups`, the only writable path in the image.

A developer's `.env` points at the host, which is why these are set in `docker-compose.yml`
rather than inherited. Getting this wrong is an afternoon: the container reads a host-shaped URL,
cannot resolve it, and the error names DNS rather than configuration.

On the Zima the same two values are written into `server.env` directly, because that file is only
ever read by containers — there is no host-shaped copy to disagree with.

## Labels for Shipyard

Shipyard (SHP) is the deploy tool for this host. It verifies a release from the published image's
labels rather than trusting a tag, and it reads two beyond the ones `docker/metadata-action` sets
on its own:

| Label | Meaning |
|---|---|
| `org.opencontainers.image.revision` | The commit SHA, set by `docker/metadata-action`. |
| `dev.d3cloud.shipyard.migration` | `expand`, `contract` or `none`. A `contract` release is never auto-rolled back (SHP-D-057) — the schema it left behind may no longer match an older image. |
| `dev.d3cloud.shipyard.schema` | The newest migration directory name at build time. Shipyard compares it with what `/health` reports as `schemaRevision` once the new image has booted. |

Both are computed by `scripts/shipyard-labels.sh` in the `images` job of `.github/workflows/ci.yml`
and passed into `docker/metadata-action`'s `labels:` input, which merges them with its own. The
`migration` label comes from the HEAD commit's `Shipyard-Migration` git trailer:

```
Shipyard-Migration: contract
```

- Missing entirely → `none`.
- `expand`, `contract` or `none` (case-insensitive, leading/trailing whitespace trimmed) → used
  as given.
- Anything else fails the `images` job with a clear message. There is no silent default for a
  typo'd value, because the whole point is that Shipyard trusts the label without re-deriving it.

Add the trailer to a commit — including a merge commit, since Shipyard reads whatever ends up at
`HEAD` on `main` — whenever that commit's migrations are additive-only (`expand`), destructive
(`contract`), or the release carries no schema change at all (`none`, the default). Run
`bash scripts/shipyard-labels.sh` locally against any checkout to see what CI will compute.

## Health after a deploy

- `/health` — schema revision, whether D3 Auth is reachable.
- `/system` — the queue, last ingest, last backup, last restore drill.
- Both logins still work. The password path must work with D3 Auth unreachable (FRM-REQ-017);
  an e2e test asserts it, but after a deploy it is worth seeing.
