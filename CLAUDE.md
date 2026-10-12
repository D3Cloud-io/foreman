# CLAUDE.md — Foreman

Plan-vs-reality ledger for the D3 Cloud ecosystem. Replaces the Obsidian vault as the source of truth for structured project state — requirements, phases, tasks, ADRs, audit findings, documents — behind two equal-peer surfaces: a React console and an **MCP server**. Read this file, then `foreman_brief FRM`, before writing code.

## Where the plan lives

Foreman tracks itself as project **`FRM`** — 178 requirements, 11 phases, 17 ADRs. It has since the
P10 cutover on 2026-09-20, which is the point: the tool holds its own remaining work.

- `foreman_brief FRM` — the active phase, what is next, what is blocked, drift.
- `foreman_coverage FRM` — uncovered Musts, tasks citing nothing, EARS warnings.
- `foreman://FRM/architecture`, `/data-model`, `/api-contract`, `/ux-flows`, `/glossary`.
- **ADR-001** Node/Express/Prisma over Python/FastAPI · **ADR-002** a small verb surface over a large graph · **ADR-003** local stdio shim, not a remote MCP server · **ADR-004** dual login as a permanent ecosystem pattern · **ADR-005** attribution is declared, not inferred · **ADR-006** five registers are views, not documents · **ADR-007** database backup as the only escape hatch · **ADR-008** project-prefixed human IDs · **ADR-009** one cutover, not a migration window · **ADR-013** remote MCP uses pre-registration, not DCR or CIMD · **ADR-014** *(proposed)* MCP may delete what nothing cites · **ADR-015** a project idea is its own entity, not an idea with no project · **ADR-016** *(proposed)* Foreman runs as one of two products, chosen by deployment · **ADR-017** a project idea grows through a named canvas, not a blank page · **ADR-018** phase status and project lifecycle are derived from what is beneath them · **ADR-022** deleting an account removes the person and keeps what they wrote attributed.

The archived vault at `../D3 Cloud Vault/Foreman/` holds the pre-cutover plan. Read it for history;
never write to it.

Start a session with `/start-development foreman`.

## Stack (locked)
Node 22 (ESM, TypeScript strict) · Express · Prisma + PostgreSQL 16 · React 19 + Vite 7 + `@d3cloud/ui` (console served as statics by the server) · MCP TypeScript SDK, spec **2026-07-28** · `argon2` · `otpauth` · `@d3cloud/auth-client` · Vitest · Playwright · pnpm 10 workspaces.

## Layout
```
apps/server            Express API, Prisma schema + migrations, dual auth, webhook receiver,
                       CLI (import, backup, reconcile, issue-token, seed-example)
apps/web               React console, served as statics by the server
apps/worker            job-queue drain: ingest, attribution, scans, reconcile, backup
packages/shared        domain types + generated API client + EARS parser — the single
                       source of truth for every entity shape
packages/mcp           @d3cloud/foreman-mcp — publishable stdio shim
fixtures/vault         real vault files copied in, for golden importer tests
docs/runbooks          deploy, backup-restore, github-app-setup, import
```

## Commands (once scaffolded per Phase 0)
```bash
pnpm install
pnpm dev:up                # writes .env if missing, builds, migrates, seeds the example project
pnpm seed:example          # disposable project exercising every entity and enum
pnpm dev:down
pnpm lint && pnpm typecheck && pnpm test          # what CI runs first
DATABASE_URL=postgresql://foreman:foreman@127.0.0.1:5432/foreman_test pnpm --filter foreman-server test:integration
pnpm e2e
pnpm --filter foreman-server run import -- --path "../D3 Cloud Vault" --only "<Folder>" --write
# Not writing is the default; `--write` is the flag. Used at the P10 cutover and for the fourteen
# projects still only in the archive.
pnpm --filter foreman-server run reconcile-status -- --write
# Derives phase status from tasks and project lifecycle from phases over data written before the
# rollup existed (ADR-018). Reports by default; promotes only, and lists closed phases it held.
pnpm --filter foreman-server run relint -- --write
# Re-runs the EARS lint over requirements already stored. The importer did not lint until
# 2026-09-20, so everything it wrote sat on the column defaults — unparsed, not ok, no note.
```

## Non-negotiables
- **`packages/shared` is the single source of truth.** Every entity declared once; API validation, console types and **MCP tool schemas are generated from it**. A contract test asserts the MCP schemas match (`FRM-REQ-081`).
- **An unconfirmed attribution is never truth.** No coverage, status, brief or drift calculation may read a `commit_task` row with `confirmed = false`. A file-path coincidence must never mark work complete. Never-regress test #1.
- **The importer never silently drops a file.** Every source file appears in the reconciliation report as mapped, partial or unmapped, with a reason. Silence is the failure mode. Never-regress test #2.
- **The server never calls an LLM.** No AI SDK in any `package.json`. Claude is Foreman's *user*, via MCP — not its dependency. A test enforces this (`FRM-REQ-013`).
- **At most 12 MCP tools**, and total tool-definition size stays inside its token budget — both asserted by contract tests. **The ceiling is now full: 12/12.** Long content goes through **resources** (`foreman://<code>/architecture#deployment`), never tool output. ADR-002 caps the *verb* surface, not the kinds one verb reaches: `foreman_create` makes projects, requirements, tasks, phases and ideas. ADRs, risks, decisions and terms are deliberately absent from it — each carries a body `foreman_update` cannot write, so creating one over MCP would make a titled shell nothing could fill. Those go through the API with a write-scoped token.
- **`foreman_delete` deletes what nothing cites** — an idea, and a project idea (ADR-014, `proposed`). ADR-002 made deletion absent from the shim rather than gated, because what a delete costs is its *citations* and a tool call cannot see them. So the absence is narrowed rather than reversed: `DeleteInput` refuses any other prefix, in `packages/shared`, and names the console instead. Widening it is an ADR, not an edit to the refinement.
- **A project idea belongs to no project** (ADR-015), which is why it is its own table with a codeless `PI-007` ID drawn from a Postgres sequence, reached at `/api/project-ideas`, and shown beside Projects rather than inside one. **A project code is chosen at conversion and nowhere else** — it is immutable and embedded in every ID the project will ever have (ADR-008), so asking for one to write down "maybe someday" is a permanent question at the moment of least information. `parseAnyId` is the one function that takes both ID shapes; everything needing a real project keeps `HumanId` and still refuses `PI-007`.
- **A project idea grows through a named canvas, not a blank page** (ADR-017). Five prompted sections — the problem, who it is for, how it might work, why now, what would kill it — plus a pitch and one small scratchpad; checklists, links, tags, related IDs, a 1–5 excitement, and a dated thoughts log. `IDEA_SECTIONS` in `packages/shared` is the one list the console, the API, `foreman_update`'s `section` field and the converted brief all read. **This narrows "no freeform wiki or note-taking"; it does not repeal it**: the structure is what keeps an idea comparable to the next one. Adding a section is fine; adding a blank page is the thing the anti-feature is for. Converting writes the canvas into the new project as its `discovery` document.
- **Guidelines are the ecosystem's standing decisions** (FRM-REQ-186 … 188) — the second record that belongs to no project, with a codeless `GL-004` ID from its own Postgres sequence, at `/api/guidelines` and `/guidelines`. Named fields (title, area, decision, rationale, guidance), not a page: **the decision is the line every brief and the portfolio carry**, so it stays short, and it is budgeted apart from the project's state (`GUIDELINES_TOKEN_BUDGET`). Retiring drops a card from every brief and keeps it on the page. `foreman_get GL-004` returns one whole; `foreman://guidelines` is all of them as Markdown. No new MCP tool — writes go through the console or the API with a write token. `GL`, like `PI`, can never be a project code.
- **Scoring and thoughts work in both modes** at `/api/project-ideas/:id/scores|comments`. Only members, invitations and funding are board-only.
- **The Prisma enums mirror `packages/shared/src/enums.ts` value for value**, asserted by `enums-mirror.test.ts`. This was listed as a non-negotiable and enforced by nobody until 2026-09-21, and it had already drifted: `idea` was in the Prisma `EntityType` and not the shared one.
- **A write-scoped API token is minted from the console**, at `/tokens`. The routes existed from P2 with nothing reaching them, so the only way was `issue-token` over SSH — which made the credential the audit and planning skills need unobtainable from the tool that issues it. `FOREMAN_URL` and `FOREMAN_WRITE_TOKEN` are what those skills read.
- **Dual login, both paths always.** App-native (Argon2id + pepper + TOTP) *and* D3 Auth OIDC. Identities link by `(iss, sub)`, **never by email**. One e2e test asserts the password path still works with the issuer unreachable.
- **`phase.number` is `numeric`** (Bindery shipped a Phase 8.5) and **`phase.sort_order` is independent of it** (Bindery built 0–8.5, 9–11, 13–16, with P12 still ahead).
- **Status rolls up; only parking is a decision** (ADR-018). A task write re-derives its phase (`active` / `complete` through the exit gate / `cancelled` / reopened), and a phase change promotes its project (`building`, then `deployed`, never back). `domain/rollup.ts` is the one place the rules live, and each move is its own `system` audit event (`rollup via FRM-T-11.5`). A write that changes status or phase must go through `rollupTaskPhases`/`rollupAfter`, or the ledger rots again. `reconcile-status` is the backfill, and it only promotes.
- **`requirement.phase_id` is nullable** — an unassigned requirement is the backlog.
- **`human_id` is immutable once assigned**, project-prefixed and globally unique. Renumbering breaks every citation in every document body.
- **A field a kind does not store is refused, never dropped** (FRM-T-017). `parseBody` answers 400 naming any top-level key its schema does not declare, and `CREATE_FIELDS` / `UPDATE_FIELDS` in `packages/shared` say which `foreman_create` / `foreman_update` fields each kind takes; the write tools are registered with their whole strict schema, not `.shape`, which the SDK would rebuild as a stripping object. A task's `body` was accepted and lost this way until 2026-10-12. Giving a kind a new column means adding its field to those tables.
- **EARS lint warns, never blocks.** A non-conforming requirement is stored with a warning.
- **Every mutation writes an `audit_event`** — MCP writes and importer writes included — and every mutation is undoable. Soft delete only. Logs never contain tokens, secrets or password material.
- **Irreversible or regressive MCP writes ask first**, via the 2026-07-28 MRTR `input_required` round-trip. Forward progress does not.
- **No host ports.** Cloudflare Tunnel only.
- **No time estimates** anywhere — T-shirt sizes and dependency order only.
- **No Co-Authored-By** or AI attribution in commits.

## Two products, one codebase (ADR-016)

`FOREMAN_MODE` is `solo` or `board`. **`solo` is everything below and on this page.** `board` is a
second deployment — its own database, never shared — running an innovation-fund board for several
people: roles, invitations, scoring, board-only discussion, and funding with an amount. See
[docs/runbooks/innovation-board.md](docs/runbooks/innovation-board.md).

The board's routes are mounted in **both** modes and answer 404 in `solo`, because a route that
exists only in one build is a route only one build has ever run.

**This narrows the anti-features below; it does not repeal them.** They protect the plan-vs-reality
ledger — a comment on a requirement or an assignee on a finding is the issue tracker Foreman exists
not to be. `board-stays-in-its-lane.test.ts` fails if a comment or a score ever references a
requirement, task, phase, finding, ADR or decision. That test is the entire basis on which the
reversal is scoped rather than wholesale, so it is the one to read before extending any of it.

## Anti-features — do not build these
No sprints, velocity, story points or burndown · no time tracking · **no freeform wiki or note-taking** (the guardrail that stops Foreman decaying back into the vault) · no multi-user collaboration, comments, assignees or notifications · no public, client-facing or shareable views · no general issue or bug tracking · no due dates, Gantt or scheduling · no drag-and-drop as the primary interface · no pull-request ingestion · no server-side LLM call · no Redis.

Each of these is recorded as a requirement asserting its **absence**, so it cannot quietly arrive: `FRM-REQ-013`, `030`, `041`, `099`, `125`, `135`.

## Bumping `@d3cloud/ui`

The library is consumed as a **GitHub release tarball**, and pnpm has a trap here that has cost an
hour twice. After changing the version in `apps/web/package.json`, a plain `pnpm install` writes a
lockfile entry with **no `integrity` field** — it reuses a URL-keyed entry in the store instead of
re-resolving. Local installs work; `pnpm fetch --frozen-lockfile` in the Docker build fails with
`ERR_PNPM_MISSING_TARBALL_INTEGRITY`, so it only shows up when the image is built.

```bash
# After bumping the version, do this, or the image build fails later:
rm -rf ~/Library/pnpm/store/v10/https+++github.com+matdemers1+d3-design-system+releases+download+v<VERSION>+d3cloud-ui-<VERSION>.tgz
rm -f pnpm-lock.yaml
pnpm install
grep -A1 "d3cloud-ui-<VERSION>.tgz':" pnpm-lock.yaml   # must show `integrity: sha512-…`
```

Removing `node_modules` alone is not enough once the bad entry is in the lockfile: pnpm reads it
and refuses rather than re-resolving.

## Cross-repo work
| Repo | What | Phase |
|---|---|---|
| `d3-design-system` | `Table`/`DataGrid` in `@d3cloud/ui` → v1.2 | P0 (T-0.9) |
| `d3-auth` | register Foreman as an OIDC client | P0 (T-0.8) |
| `.claude/skills/` | rewrite all five vault-writing skills | P10 only |

## Conventions
- Update the vault SOW as tasks land; write an ADR for any deviation from the plan.
- `d3-check-usage` runs on the console: tokens only, no raw hex, no shadows.
- Development runs against the **disposable example project**. The real corpus is imported once, in P10, and not before.

## The native app contract (FRM-P-14)
D3 Constellation reaches Foreman through the D3 App contract (`matdemers1/d3-app-contract`, CON-ADR-003). `src/routes/native.ts` and the session helpers in `src/auth/sessions.ts`:
- `GET /.well-known/d3-app.json`; `/auth/native/{signin,refresh,revoke,link}` (outside `/api`, which is guarded whole); `GET /auth/me` in the contract's words; `GET /auth/sessions` and `POST /auth/sessions/:id/revoke` behind the Tokens screen's **Signed in**.
- Sign-in checks the password and code with the console login's own `passwordStep` / `codeStep` (`src/auth/native.ts`) — one way to check a password, not two. **A native session is a `session` row** with `native = true`; its Bearer access token is the row's hash, fifteen minutes, never slid; refresh rotates through `native_refresh` and a replayed token revokes the session. A cookie only resolves a browser row and a Bearer token only a native one.
- **Two D3 Auth audiences, each path accepting exactly its own.** `/mcp` (and the API calls it loops back, marked with `MCP_LOOPBACK_HEADER` and a boot-time secret) takes `<BASE_URL>/mcp`; every other request takes the app's audience, Foreman's origin. An app token acts as the person (`actorKind: user`, read/write, their role) but is never a console session — `requireUser` refuses it, so it can never mint an `frm_` token. A native session *is* a person signed in with their own password and code, and passes `requireUser`.
- Refusals to a native client (a non-`frm_` Bearer outside `/mcp`): 401, 403 and 429 become the contract's problems; 412 and 422 keep their shape, which the app reads as they are.
- **Push** (FRM-T-15.4, `src/push/`, `src/routes/push.ts`): `POST /api/push/native/register` takes the device's P-256 key and its relay registration (send key sealed under the KEK); it belongs to the native session — revocation is soft, so `sessions.revoke` forgets it explicitly — or for an app token to the identity; a 410 from the relay forgets it. Only https relays, except `RELAY_ALLOW_LOOPBACK_HTTP=1` for CI's mock relay.
- **Invitations and account deletion** (FRM-T-15.2/15.3, board mode only — a solo Foreman's manifest names neither): `POST /auth/native/invite` spends the invitation with the console's own `acceptInvite`, enrols an authenticator and signs in once a code proves it; `POST /auth/native/delete-account {confirmation: <host>, totp}` refuses the last admin (`last_owner`), suspends the account with `delete_after` a week out, ends every session and API token it made, and the nightly `purge-deleted-accounts` job purges it — credential, identities, sessions, email — keeping the row and display name so what they wrote stays attributed (ADR-022). Lifting the suspension cancels it. Invite links are `/invite?token=` (the console still answers `/accept`).
- **"Open in D3 Constellation"** (FRM-T-15.1): `components/OpenInConstellation.tsx`, on Apple devices only, on the task, requirement, finding, document and project screens — `d3constellation://<host>/foreman/{item/<humanId>|project/<code>|document/<code>/<kind>}`.
- CI's `conformance` job runs the suite against `test/conformance-server.ts`, a board deployment seeded with its only admin (`--main-is-last-owner`), an invitation and a disposable account; the image is public and pulled with no token; when it cannot be pulled, `contract-suite` writes the reason to its summary and `conformance` is skipped, never green (CON-T-002).

## Deploying — through Shipyard, never by hand

This app is deployed by **Shipyard** (`https://shipyard.d3cloud.io`). Deploy through its MCP server,
never over SSH: no `sed` on a compose file, no `docker compose pull/up` on the host. A deploy done by
hand is drift, and Shipyard refuses the next one until someone resolves it.

- **Connect once:** remote MCP server `https://shipyard.d3cloud.io/mcp`, header
  `Authorization: Bearer <token>`. A token is scoped to the apps it names; ask the operator for one
  (`host-admin issue-token --apps <app>` on the host). Never paste it into a file in this repo.
- **What exists:** `shipyard_status` (live release, commits waiting, CI) · `shipyard_dry_run` ·
  `shipyard_deploy` (an `app`, or a `group`, and a 40-hex `sha`) · `shipyard_deploy_status` ·
  `shipyard_rollback` (to an earlier successful deploy, from the agent's own ledger).
- **What you can deploy:** only a SHA on the default branch whose image workflow is green and that
  is ahead of what is live. Shipyard re-checks all of it on the host; a refusal names the gate and
  the fix — read it, don't retry the same call.
- **Every deploy request names you:** `requester: { label: "claude: <repo> <what>", repo, branch }`.
  The label is what someone locked out will see.
- **Shipyard never queues.** `locked` means someone else is deploying: wait for their deploy to
  finish (`shipyard_deploy_status`), then ask again.
- **Approval-required apps** (d3auth) wait for a deployer to approve in the console; say so and stop
  there rather than polling for an hour.
- **Migrations:** put a `Shipyard-Migration: expand|contract|none` trailer on the commit that
  changes the schema (default `none`). A `contract` release is never auto-rolled back — if it fails,
  Shipyard stops it on the new image, and a restore is a person's decision in the console.
- **When it finishes, report** the deploy ID, the final state, the commit SHA **per image**, and the
  schema revision `/health` reports — `shipyard_deploy_status` returns all of them. On a
  `rolled_back` or `failed`, report the refusal's message and fix verbatim.
