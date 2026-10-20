# Running an innovation-fund board

A second deployment of this codebase, for a group of people rather than one operator
(**FRM-ADR-016**). Same image, same migrations, **different database**.

> [!warning] The two modes must never share a database
> Not because anything would break — the schema is identical — but because the whole reason for a
> second deployment is that the two sets of data belong to different people. A board deployment
> holds colleagues' submissions; a solo deployment holds one person's projects. One database would
> put an employer's innovation pipeline in the same place as somebody's personal side projects,
> and the only way to separate them afterwards is a migration nobody wants to write.

## What differs

| | `solo` | `board` |
|---|---|---|
| Accounts | one operator | invited, with roles |
| Roles | ignored entirely | `admin` · `reviewer` · `submitter` |
| Sidebar | Projects, Project ideas | Submissions, Members |
| An idea's ending | converted into a project | funded, with an amount |
| Scoring, discussion | absent | present |
| `/api/board/*` | `404` | live |

Everything else — the ledger, documents, findings, the MCP surface — is unchanged and still
reachable. A board deployment simply does not lead with it.

## Standing it up

```bash
# 1. A database of its own. Not a schema inside the solo one; its own database.
createdb foreman_board

# 2. Its own secrets. Sharing KEK, PEPPER or COOKIE_KEYS between deployments would mean a
#    session or a TOTP secret from one is valid in the other.
openssl rand -base64 32   # KEK
openssl rand -base64 32   # PEPPER
openssl rand -base64 32   # COOKIE_KEYS

# 3. server.env, with the two lines that make it a board:
#      FOREMAN_MODE=board
#      CURRENCY=USD
```

> [!note] No board deployment is live
> The one board that ran — `/DATA/foreman-board` at `board.d3cloud.io`, which only ever held
> example data — was retired on 2026-10-07 (FRM-T-015). Its final dump is
> `/DATA/Backup/foreman-board-final-2026-10-07.dump`; its directory, tunnel and Shipyard manifest
> are gone. The `foreman` Shipyard group's canary is now `foreman-asksage`, a second **solo**
> instance. The work innovation board went on as its own product, Overflow (OVF).

A board stood up again would follow the same shape: its own directory, Postgres container, volume,
tunnel and secrets, sharing nothing with `/DATA/foreman`, and its own compose project name so every
command needs `-p <name>`.

Migrations run on boot, before the server serves.

**A fresh board database has no accounts at all**, and inviting somebody requires an admin — so
there is one command to break the circle:

```bash
docker compose exec server node dist/cli/bootstrap-admin.js you@example.com
# prints a generated password once, or takes BOOTSTRAP_PASSWORD from the environment
```

Everyone else arrives by invitation from there. (The command is also the answer to "the only admin
is locked out": run it again for that address and it sets a new password.)

On a database that already had accounts — the solo instance being upgraded, not a new board — the
migration promotes every pre-existing account to `admin` instead, because they had unrestricted
access before roles existed and defaulting them to `submitter` would be locking the owner out
rather than tightening anything.

## Inviting people

Members → Invite. The link is shown on screen **as well as** emailed, deliberately: mail is the
convenient path and not the reliable one, and an admin who cannot see the link has no way to tell
a bounced invitation from one sitting unread.

An invitation is a credential and is treated as one — random, stored only as a SHA-256, single
use, and expiring after `INVITE_TTL_HOURS`. Accepting it sets a password and **does not sign
anybody in**: a forwarded invitation email must not be a session.

If the mail relay is not configured, invitations still work. The link is the mechanism; the email
is a convenience.

## Roles

- **submitter** — submits, discusses, edits and withdraws their own. Sees every submission, and
  the public reason for every decision. Never sees a score.
- **reviewer** — the board. Sees and scores everything, leaves board-only notes, moves a
  submission through the pipeline, and funds it.
- **admin** — a reviewer who can also invite, change roles and suspend accounts.

The last admin cannot be demoted or suspended. An instance with no admin cannot appoint one, and
the fix is a database console.

## What the board sees and the submitter does not

Exactly one thing: **scores**. They are filtered out of the API response, not hidden by the
console, and internal comments are filtered the same way — the count on the Discuss button counts
public comments only, so it cannot leak the existence of a board-only note.

Everything else is shared on purpose. A fund whose submissions are private produces the same idea
six times; a fund that decides in a meeting and never says why gets the same proposal again next
quarter.

## Sign-in

App-native invitations today: email, password (12 characters minimum), optional TOTP.

**This is not the long-term answer for a workplace.** Colleagues' access to a work tool should not
depend on an account system somebody runs personally. Foreman already speaks OIDC — pointing it at
a corporate issuer is `D3AUTH_ISSUER`, `D3AUTH_CLIENT_ID` and `D3AUTH_CLIENT_SECRET` plus a claims
mapping, not new architecture. Identities link by `(iss, sub)` and **never by email** (ADR-004),
so an existing account can be linked to an SSO identity without becoming a way in for anybody who
can spoof an address.

## Backups

Identical to the solo deployment — see [backup-restore.md](backup-restore.md) — but the dump
directory must be its own, for the same reason the database is.

Run the restore drill before anybody submits anything real. A backup nobody has restored is a
belief, not a backup.
