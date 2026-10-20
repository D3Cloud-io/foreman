# Importing Figma frames as screen proposals

A project's board in Figma holds the intended look of each screen. Foreman keeps that as a
**proposal** on a screen: the frame's PNG plus where it came from — the Figma file key, the frame's
node ID and the file version (FRM-REQ-192). This command adds one proposal per frame from a
mapping file, and adds nothing for a frame that has not changed (FRM-REQ-204).

**Foreman's server never calls Figma** (FRM-ADR-023). The command runs on your machine (or in a
Claude session) and talks to Figma, if at all, from there, then to Foreman's REST API like any other
client. The deployed server holds no Figma credential.

```bash
export FOREMAN_URL=https://foreman.d3cloud.io
export FOREMAN_WRITE_TOKEN=frm_…         # minted at /tokens, write scope
cd apps/server
pnpm run import-figma -- --mapping ./figma-map.json --dry-run   # look first
pnpm run import-figma -- --mapping ./figma-map.json             # then write
```

In the built image the same command is `node dist/cli/import-figma.js --mapping …`.

| Flag | What it does |
|---|---|
| `--mapping <file>` | The mapping file. Required. |
| `--dry-run` | Resolve every frame and report what would happen; upload and create nothing. |
| `--prefer-local` | Use a frame's `png` even when `FIGMA_TOKEN` is set. |

## The mapping file

```json
{
  "project": "FRM",
  "figmaFileKey": "U0kWWofDq6tP5m8OljAQJW",
  "fileVersion": "2294810350",
  "frames": [
    { "nodeId": "12:34", "screen": "FRM-SCR-001", "viewport": "desktop", "theme": "dark",
      "png": "./exports/overview-desktop-dark.png" },
    { "nodeId": "12:40", "screen": "FRM-SCR-001", "viewport": "mobile", "theme": "dark",
      "png": "./exports/overview-mobile-dark.png" },
    { "nodeId": "15:2", "screen": { "name": "Tokens", "route": "/tokens" },
      "viewport": "desktop", "theme": "light" }
  ]
}
```

- `figmaFileKey` is the part of the Figma URL after `/design/`. `nodeId` is the `node-id=` value;
  `12-34` and `12:34` are the same node, and the ID is stored as you wrote it.
- `screen` is either an existing screen ID, which must exist, or `{ name, route? }`, which finds a
  screen of that name or **creates it** (with this frame's file key and node ID as its own). Two
  frames of one name share the screen they create.
- A screen has one current proposal for each viewport and theme, so two frames may not name the same
  screen, viewport and theme: the second would supersede the first. The command refuses that up front.
- `png` is relative to the mapping file. `fileVersion` is needed only without a token.

## Path 1: with a Figma token

1. In Figma: account menu, **Settings**, **Security**, **Personal access tokens**, **Generate new
   token**. Give it the scope **File content: Read-only** (`file_content:read`), and nothing else.
2. `export FIGMA_TOKEN=figd_…`. It is read from the environment only and never printed.
3. Run the command. It reads the file's `version` (`GET /v1/files/:key?depth=1`), renders every
   frame at 2x (`GET /v1/images/:key`, fifty nodes a request), and downloads each PNG.

With a token, a frame's `png` is ignored unless `--prefer-local`. A frame Figma cannot render (a
node ID that does not exist, or an `err`) fails alone; the others still import.

## Path 2: from a Claude session, with no token

A Claude session has the Figma MCP but no personal access token.

1. For each frame, call the Figma MCP's `get_screenshot` (or the download it offers) and save the PNG
   next to the mapping file.
2. Read the file's version from the MCP's file metadata (or the Figma file's version history) and put
   it in `fileVersion`. The version is what ties these pixels to a moment in the file, so it must be
   the one the export was taken at.
3. Fill each frame's `png`, then run the command. Every file's first eight bytes are checked to be a
   PNG's before anything is uploaded.

## What "unchanged" means

A frame is **unchanged**, and nothing is uploaded or written, when the screen's current proposal for
that viewport and theme already has the same **file key, node ID, file version and image (SHA-256)**.
Change any one and a new proposal supersedes the old, which stays readable (FRM-REQ-193). So:

- a rerun at the same Figma version adds nothing;
- saving a new version of the Figma file proposes again for every frame, even a pixel-identical one,
  because the version is part of the provenance;
- the same image from a different node is a new proposal, not a duplicate.

The server applies the same rule as a backstop and answers 200 rather than 201 for a repeat.

## Reading the output

```
created   FRM-SCR-001 desktop/dark 12:34  proposed at version 2294810350
unchanged FRM-SCR-001 mobile/dark 12:40  already current at version 2294810350
failed    FRM-SCR-002 desktop/dark 15:2  Figma returned no image for this node (does it exist?)
file version 2294810350: 1 created, 1 unchanged, 1 failed
```

Exit status is 0 when nothing failed, 1 when any frame failed, and 2 for a mistake in the mapping or
the environment (nothing was written). A failed frame is safe to rerun: blobs are content-addressed
and finished frames report `unchanged`.

## Where this fits in /plan-project

`/plan-project` ends its UI step with a Figma board named `<Project> (<CODE>)`. Once the frames
exist, create the screens (`POST /api/projects/:code/screens`, or let the mapping's `{ name }` form
do it), write the mapping beside the board's notes, and run this command. Rerun it after the design
moves on: only the frames that changed become new proposals, and `foreman_coverage` and the drift
view read them as the intended look to compare captures against.

Relates to FRM-REQ-192, FRM-REQ-193, FRM-REQ-204 and FRM-ADR-023.
