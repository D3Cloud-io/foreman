import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PortfolioRow, TokenRow } from '../lib/api';
import {
  labelSamples,
  readSetupDismissed,
  realRows,
  SETUP_DISMISSED_KEY,
  SetupChecklist,
  setupSteps,
  setupSummary,
  showFinishCard,
  writeSetupDismissed,
} from './FirstRun';
import { sectionSummary } from '../lib/groups';
import {
  AgentTabs,
  canWrite,
  firstCallLine,
  remoteSnippet,
  shimSnippet,
  skillsSnippet,
} from './ConnectAgent';
import { codeProblem, importCommands, stampedIds } from './Projects';

/**
 * First run from the console (FRM-T-18.9, FRM-REQ-248, FRM-DA-009): the checklist ticked from real
 * state, the three snippets as they really are, the code rule, and the import lines.
 */

const COUNTS = {
  'coverage-hole': 0,
  'stale-task': 0,
  'fired-tripwire': 0,
  'failed-exit-gate': 0,
  'orphan-adr': 0,
  'screen-drift': 0,
} as const;

function row(code: string, over: Partial<PortfolioRow> = {}): PortfolioRow {
  return {
    code,
    name: `${code} name`,
    lifecycle: 'planned',
    phase: null,
    tasks: { open: 0, blocked: 0, done: 0, cancelled: 0 },
    openCriticals: 0,
    ci: { conclusion: null, unknown: true },
    unconfirmedAttributions: 0,
    drift: { counts: { ...COUNTS }, total: 0 },
    lastActivityAt: null,
    group: null,
    sample: false,
    ...over,
  };
}

function token(over: Partial<TokenRow> = {}): TokenRow {
  return {
    id: 't1',
    name: 'claude-mbp shim',
    prefix: 'frm_Q7xN2kLp',
    scopes: ['read', 'write'],
    lastUsedAt: null,
    expiresAt: null,
    revokedAt: null,
    createdAt: '2026-10-21T12:00:00.000Z',
    ...over,
  };
}

const SAMPLES = [row('EXMP', { sample: true, lastActivityAt: '2026-10-20T10:00:00.000Z' }), row('NBR', { sample: true })];
const ORIGIN = 'https://foreman.example.com';

describe('the setup checklist, ticked from real state', () => {
  it('ticks nothing with only samples and an unused token — a sample commit is not a first commit', () => {
    const steps = setupSteps({ tokens: [token()], rows: SAMPLES, linked: [] });
    expect(steps.map((s) => [s.key, s.done])).toEqual([
      ['agent', false],
      ['project', false],
      ['repo', false],
      ['commit', false],
    ]);
    expect(steps.map((s) => s.state)).toEqual(['next', 'waiting', 'waiting', 'waiting']);
    expect(steps[0]?.evidence).toContain('waiting for its first call');
    expect(setupSummary(steps)).toBe('0 of 4 done');
  });

  it('ticks the agent from the token’s last-used time, and never from a revoked-and-unused one', () => {
    const used = setupSteps({ tokens: [token({ lastUsedAt: new Date().toISOString() })], rows: [], linked: [] });
    expect(used[0]?.done).toBe(true);
    expect(used[0]?.evidence).toContain('claude-mbp shim');
    expect(used[1]?.state).toBe('next');

    const revoked = setupSteps({ tokens: [token({ revokedAt: new Date().toISOString() })], rows: [], linked: [] });
    expect(revoked[0]?.done).toBe(false);
    // Not read is never a tick.
    expect(setupSteps({ tokens: null, rows: [], linked: null })[0]?.done).toBe(false);
  });

  it('ticks a project, a linked repository and a first commit from real projects only', () => {
    const rows = [...SAMPLES, row('BURR'), row('CW')];
    const linked = setupSteps({ tokens: [], rows, linked: ['CW'] });
    expect(linked.map((s) => s.done)).toEqual([false, true, true, false]);
    expect(linked[1]?.evidence).toBe('BURR BURR name and CW CW name');

    const committed = setupSteps({
      tokens: [token({ lastUsedAt: new Date().toISOString() })],
      rows: [...rows.slice(0, 3), row('CW', { lastActivityAt: new Date().toISOString() })],
      linked: null,
    });
    // A commit implies its repository.
    expect(committed.map((s) => s.done)).toEqual([true, true, true, true]);
    expect(setupSummary(committed)).toBe('4 of 4 done');
  });

  it('renders each step with its word — done is a neutral check, not green', () => {
    const steps = setupSteps({ tokens: [token({ lastUsedAt: new Date().toISOString() })], rows: SAMPLES, linked: [] });
    const html = renderToStaticMarkup(<SetupChecklist steps={steps} rows={SAMPLES} />);
    expect(html).toContain('Set Foreman up');
    expect(html).toContain('1 of 4 done');
    expect(html).toContain('>done<');
    expect(html).toContain('>next<');
    expect(html).toContain('waiting on step 2');
    expect(html).toContain('New project');
    expect(html).toContain('Import…');
    expect(html).not.toMatch(/success/);
  });
});

describe('samples', () => {
  it('are left out of the real rows and labelled where they are listed', () => {
    expect(realRows([...SAMPLES, row('FRM')]).map((r) => r.code)).toEqual(['FRM']);
    expect(labelSamples([SAMPLES[0] ?? row('X'), row('FRM')]).map((r) => r.name)).toEqual(['EXMP name · Sample', 'FRM name']);
  });
});

describe('the three ways an agent connects (FRM-DA-009)', () => {
  it('remote MCP is the server’s /mcp over HTTP, with no token', () => {
    expect(remoteSnippet(ORIGIN)).toBe(`claude mcp add --transport http foreman ${ORIGIN}/mcp`);
    expect(remoteSnippet(ORIGIN)).not.toMatch(/TOKEN/);
  });

  it('the local shim reads FOREMAN_URL and FOREMAN_TOKEN', () => {
    const text = shimSnippet(ORIGIN, 'frm_secret');
    expect(text).toContain(`FOREMAN_URL=${ORIGIN}`);
    expect(text).toContain('FOREMAN_TOKEN=frm_secret');
    expect(text).not.toContain('FOREMAN_WRITE_TOKEN');
  });

  it('the skills read FOREMAN_URL and FOREMAN_WRITE_TOKEN, and are shown only for a token that can write', () => {
    expect(skillsSnippet(ORIGIN, 'frm_w')).toBe(`export FOREMAN_URL=${ORIGIN}\nexport FOREMAN_WRITE_TOKEN=frm_w`);
    expect(canWrite(['read'])).toBe(false);
    expect(canWrite(['read', 'write'])).toBe(true);

    const readOnly = renderToStaticMarkup(
      <AgentTabs origin={ORIGIN} oidcAvailable initial="skills" token={{ name: 'ci-reader', secret: 'frm_r', scopes: ['read'] }} />,
    );
    expect(readOnly).toContain('Needs a token that can write');
    expect(readOnly).not.toContain('FOREMAN_WRITE_TOKEN=frm_r');

    const writer = renderToStaticMarkup(
      <AgentTabs origin={ORIGIN} oidcAvailable initial="skills" token={{ name: 'skills', secret: 'frm_w', scopes: ['read', 'write'] }} />,
    );
    expect(writer).toContain('FOREMAN_WRITE_TOKEN=frm_w');
    expect(writer).toContain('Copy');
  });

  it('says it is waiting for the first call until the token’s last-used time moves', () => {
    expect(firstCallLine({ name: 'shim', lastUsedAt: null })).toBe('Waiting for the first call from “shim”…');
    expect(firstCallLine({ name: 'shim', lastUsedAt: '2026-10-21T14:02:00.000Z' })).toMatch(/^Connected · first call at /);
    const html = renderToStaticMarkup(
      <AgentTabs origin={ORIGIN} oidcAvailable initial="shim" watched={{ name: 'shim', lastUsedAt: null }} />,
    );
    expect(html).toContain('Waiting for the first call');
    expect(html).toContain('aria-live="polite"');
  });
});

describe('New project and Import', () => {
  const taken = [row('BURR', { name: 'Burrow' })];

  it('checks the code against the shared rule, in words a person can act on', () => {
    expect(codeProblem('', taken)).toBeNull();
    expect(codeProblem('KURO', taken)).toBeNull();
    expect(codeProblem('kuro', taken)).toBe('Upper case only. Did you mean KURO?');
    expect(codeProblem('BURR', taken)).toBe('BURR is Burrow’s code already.');
    expect(codeProblem('K', taken)).toBe('At least 2 characters.');
    expect(codeProblem('PI', taken)).toMatch(/reserved/);
    expect(codeProblem('1ABC', taken)).toMatch(/letter first/);
    expect(stampedIds('KURO')).toBe('KURO-REQ-001, KURO-ADR-001, KURO-T-1.1');
  });

  it('shows the import as the CLI: the dry run first, then the same with --write', () => {
    const { dryRun, write } = importCommands('../d3cloud-archive/D3 Cloud Vault', 'Kardashev');
    expect(dryRun).toBe(
      'pnpm --filter foreman-server run import -- --path "../d3cloud-archive/D3 Cloud Vault" --only "Kardashev"',
    );
    expect(write).toBe(`${dryRun} --write`);
    expect(importCommands('', '').dryRun).toContain('--path "<vault>" --only "<Folder>"');
  });
});

describe('Finish setting up, once there is a real project (board D-09)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const pending = setupSteps({ tokens: [token({ lastUsedAt: new Date().toISOString() })], rows: [row('BURR')], linked: [] });
  const done = setupSteps({
    tokens: [token({ lastUsedAt: new Date().toISOString() })],
    rows: [row('BURR', { lastActivityAt: new Date().toISOString() })],
    linked: null,
  });

  it('shows while a step is pending, and not once all four are done, put off, or unread', () => {
    expect(pending.map((s) => s.state)).toEqual(['done', 'done', 'next', 'waiting']);
    expect(showFinishCard(pending, false)).toBe(true);
    expect(showFinishCard(pending, true)).toBe(false);
    expect(showFinishCard(done, false)).toBe(false);
    expect(showFinishCard(null, false)).toBe(false);
  });

  it('offers the repository link for the next step, with a real project in it', () => {
    const html = renderToStaticMarkup(<SetupChecklist steps={pending} rows={[row('BURR')]} />);
    expect(html).toContain('/api/projects/BURR/repos');
    expect(html).toContain('FOREMAN_WRITE_TOKEN');
    expect(html).toContain('waiting on step 3');
  });

  it('remembers Not now per browser, and survives storage that refuses', () => {
    const store = new Map<string, string>();
    vi.stubGlobal('window', {
      localStorage: {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => {
          store.set(key, value);
        },
      },
    });
    expect(readSetupDismissed()).toBe(false);
    writeSetupDismissed();
    expect(store.get(SETUP_DISMISSED_KEY)).toBe('1');
    expect(readSetupDismissed()).toBe(true);

    vi.stubGlobal('window', {
      localStorage: {
        getItem: () => {
          throw new Error('denied');
        },
        setItem: () => {
          throw new Error('denied');
        },
      },
    });
    expect(readSetupDismissed()).toBe(false);
    expect(() => {
      writeSetupDismissed();
    }).not.toThrow();
  });

  it('leaves samples out of a section’s summary', () => {
    const rows = labelSamples([...SAMPLES, row('FRM', { lifecycle: 'building' })]);
    expect(sectionSummary(realRows(rows))).toBe('1 project · 1 building · 0 drift');
  });
});

describe('a new code is checked against every project, not the scope on screen', () => {
  it('names the owner of a code from the unscoped list', () => {
    const scoped = [row('KURO', { name: 'Kurō' })];
    const everyCode = [{ code: 'EXMP', name: 'Example Project' }, ...scoped];
    expect(codeProblem('EXMP', scoped)).toBeNull();
    expect(codeProblem('EXMP', everyCode)).toBe('EXMP is Example Project’s code already.');
  });
});
