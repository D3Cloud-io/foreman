import { useState } from 'react';
import { Alert, Button, Stack, TabPanel, Tabs } from '@d3cloud/ui';
import type { TokenRow } from '../lib/api';
import './FirstRun.css';

/**
 * Connect an agent (FRM-T-18.9, FRM-REQ-248, FRM-DA-009): three ways in, each a real command for
 * this instance, with a copy button.
 *
 * - **Remote MCP** — `<BASE_URL>/mcp`, signed in through D3 Auth as yourself (FRM-ADR-013). No
 *   token: one from this page would not work there.
 * - **Local shim** — `packages/mcp` reads `FOREMAN_URL` and `FOREMAN_TOKEN`, and exits at start-up
 *   when either is missing.
 * - **Skills** — the audit and planning skills read `FOREMAN_URL` and `FOREMAN_WRITE_TOKEN`. They
 *   record findings, so their snippet is shown only for a token that can write.
 *
 * "Waiting for the first call" is read from the token's `lastUsedAt` — the existing token list,
 * re-read — and turns into a plain "Connected · first call at 14:02". No new route, and no green.
 */

export type AgentTab = 'remote' | 'shim' | 'skills';

export const AGENT_TABS: readonly { value: AgentTab; label: string }[] = [
  { value: 'remote', label: 'Claude Code · remote MCP' },
  { value: 'shim', label: 'Local shim' },
  { value: 'skills', label: 'Audit & planning skills' },
];

/** What stands in for a token the page does not have: it is shown once, at issue, and never again. */
export const TOKEN_PLACEHOLDER = '<your token>';
export const WRITE_TOKEN_PLACEHOLDER = '<a token with write>';

/** Whether a token can write — what the skills need, so the only kind their snippet is shown for. */
export function canWrite(scopes: readonly string[]): boolean {
  return scopes.includes('write') || scopes.includes('admin');
}

/** The remote MCP: the server's own `/mcp`, over HTTP, signed in through D3 Auth. No token. */
export function remoteSnippet(origin: string): string {
  return `claude mcp add --transport http foreman ${origin}/mcp`;
}

/** The local stdio shim, which reads FOREMAN_URL and FOREMAN_TOKEN (`packages/mcp/src/index.ts`). */
export function shimSnippet(origin: string, token: string = TOKEN_PLACEHOLDER): string {
  return [
    'claude mcp add foreman \\',
    `  -e FOREMAN_URL=${origin} \\`,
    `  -e FOREMAN_TOKEN=${token} \\`,
    '  -- node /path/to/foreman/packages/mcp/dist/index.js',
  ].join('\n');
}

/** The skills' two variables, for a shell profile. Only ever with a write-scoped token. */
export function skillsSnippet(origin: string, token: string = WRITE_TOKEN_PLACEHOLDER): string {
  return `export FOREMAN_URL=${origin}\nexport FOREMAN_WRITE_TOKEN=${token}`;
}

/** The time of day a first call landed, as the line says it: "14:02". */
function clock(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

/** The waiting line's words, from the token's last-used time. */
export function firstCallLine(row: Pick<TokenRow, 'name' | 'lastUsedAt'>): string {
  return row.lastUsedAt === null
    ? `Waiting for the first call from “${row.name}”…`
    : `Connected · first call at ${clock(row.lastUsedAt)}`;
}

/** A line to copy, and the button that copies it. The line wraps; it never scrolls the page. */
export function Snippet({ label, text }: { label: string; text: string }) {
  const [copied, setCopied] = useState<'no' | 'yes' | 'failed'>('no');
  return (
    // A named group, not a named `<pre>`: a label on a generic element is one nothing announces.
    <div className="fm-snippet" role="group" aria-label={label}>
      <pre className="fm-secret fm-secret--quiet">{text}</pre>
      <Button
        size="sm"
        aria-label={`Copy ${label}`}
        onClick={() => {
          const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard;
          if (clipboard === undefined) {
            setCopied('failed');
            return;
          }
          void clipboard.writeText(text).then(
            () => { setCopied('yes'); },
            () => { setCopied('failed'); },
          );
        }}
      >
        {copied === 'yes' ? 'Copied' : copied === 'failed' ? 'Select it to copy' : 'Copy'}
      </Button>
    </div>
  );
}

/** The waiting line, live: it changes when the token's first call lands. */
export function FirstCall({ row }: { row: Pick<TokenRow, 'name' | 'lastUsedAt'> }) {
  return (
    <p className="fm-snippet__waiting" aria-live="polite">
      {firstCallLine(row)}
      {row.lastUsedAt === null ? ' Read from this token’s last-used time: run any foreman_* tool and this line changes.' : ''}
    </p>
  );
}

/**
 * The three tabs. `token` is the one just issued — its secret and scopes — when there is one; with
 * none, the shim and skills lines carry a placeholder for the token you were shown once.
 */
export function AgentTabs({
  origin,
  token = null,
  watched = null,
  oidcAvailable,
  initial = 'remote',
}: {
  origin: string;
  token?: { name: string; secret: string; scopes: readonly string[] } | null;
  /** The token whose first call the line waits for, as the list last read it. */
  watched?: Pick<TokenRow, 'name' | 'lastUsedAt'> | null;
  oidcAvailable: boolean;
  initial?: AgentTab;
}) {
  const [tab, setTab] = useState<AgentTab>(initial);
  const writes = token !== null && canWrite(token.scopes);

  const panel =
    tab === 'remote' ? (
      <Stack gap="12">
        <p>
          The hosted MCP at <code>/mcp</code>. No token: the first time, Claude Code opens D3 Auth and
          you sign in as yourself.
        </p>
        <Snippet label="the remote MCP command" text={remoteSnippet(origin)} />
        <p className="fm-muted">
          Then run <code>/mcp</code> in Claude Code, choose foreman, then Authenticate. A token from this
          page will not work here.
        </p>
        {!oidcAvailable && (
          <Alert tone="warning" title="D3 Auth is not reachable from this Foreman">
            The remote MCP signs you in through D3 Auth, so it cannot be used until it is. The local shim
            works without it.
          </Alert>
        )}
      </Stack>
    ) : tab === 'shim' ? (
      <Stack gap="12">
        <p>
          Runs <code>foreman-mcp</code> on your machine and calls Foreman with a token from this page. It
          reads <code>FOREMAN_URL</code> and <code>FOREMAN_TOKEN</code>, and exits at start-up if either
          is missing. Build it once with <code>pnpm --filter @d3cloud/foreman-mcp build</code>.
        </p>
        <Snippet label="the local shim command" text={shimSnippet(origin, token?.secret)} />
        {token === null && <p className="fm-muted">Issue a token, then put it in place of {TOKEN_PLACEHOLDER}.</p>}
        {watched !== null && <FirstCall row={watched} />}
      </Stack>
    ) : token !== null && !writes ? (
      <Alert tone="info" title="Needs a token that can write">
        “{token.name}” is read-only. The skills record findings, so their snippet is shown only for a
        write-scoped token. Issue one with Write ticked.
      </Alert>
    ) : (
      <Stack gap="12">
        <p>
          For <code>/design-audit</code>, <code>/plan-project</code> and the other skills that write to
          Foreman. They read <code>FOREMAN_URL</code> and <code>FOREMAN_WRITE_TOKEN</code>; put them in
          your shell profile.
        </p>
        <Snippet label="the skills variables" text={skillsSnippet(origin, token?.secret)} />
        {token === null && (
          <p className="fm-muted">Only a token issued with Write works here: put it in place of {WRITE_TOKEN_PLACEHOLDER}.</p>
        )}
        {watched !== null && writes && <FirstCall row={watched} />}
      </Stack>
    );

  return (
    <Tabs
      aria-label="How the agent connects"
      value={tab}
      onValueChange={(next) => { setTab(next as AgentTab); }}
      items={AGENT_TABS.map((item) => ({ value: item.value, label: item.label }))}
    >
      <TabPanel value={tab}>{panel}</TabPanel>
    </Tabs>
  );
}
