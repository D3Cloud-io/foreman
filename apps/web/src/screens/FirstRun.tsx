import { useId, useState } from 'react';
import { Button, Card, Cluster, Section, Stack } from '@d3cloud/ui';
import { Check } from 'lucide-react';
import { foreman, type PortfolioRow, type TokenRow } from '../lib/api';
import { useMutate } from '../lib/mutate';
import { navigate } from '../lib/router';
import { useAsync } from '../lib/useAsync';
import { Pill } from '../ui/viz';
import { relativeDay } from '../ui/tone';
import { listJoin } from '../lib/groups';
import { Snippet } from './ConnectAgent';
import './FirstRun.css';

/**
 * First run (FRM-T-18.9, FRM-REQ-248, board D-09).
 *
 * With no real project, Home is a setup checklist rather than a dashboard of zeroes that reads as
 * "all clear". Each step is ticked from what Foreman can see — never from a click:
 *
 * 1. **Connect an agent** — a live token whose `lastUsedAt` has moved.
 * 2. **Create or import a project** — a project that is not a sample.
 * 3. **Link its repository** — a real project with a repository linked.
 * 4. **See the first commit** — a commit ingested for one.
 *
 * Samples (the seeded EXMP and NBR) are labelled, counted in no figure, and removable from here.
 */

export type StepKey = 'agent' | 'project' | 'repo' | 'commit';

export interface SetupStep {
  readonly key: StepKey;
  readonly title: string;
  readonly done: boolean;
  /** `next` is the first step not done; the rest wait on it. */
  readonly state: 'done' | 'next' | 'waiting';
  /** What the tick was read from, or what is missing — said beside it. */
  readonly evidence: string;
}

/** A real project is one that is not a seeded sample. */
export function realRows<R extends Pick<PortfolioRow, 'sample'>>(rows: readonly R[]): R[] {
  return rows.filter((row) => row.sample !== true);
}

export function sampleRows<R extends Pick<PortfolioRow, 'sample'>>(rows: readonly R[]): R[] {
  return rows.filter((row) => row.sample === true);
}

/** A sample's row, labelled where its name is shown — the ledger draws the name, and nothing else. */
export function labelSamples(rows: readonly PortfolioRow[]): PortfolioRow[] {
  return rows.map((row) => (row.sample === true ? { ...row, name: `${row.name} · Sample` } : row));
}

function live(token: TokenRow): boolean {
  return token.revokedAt === null && (token.expiresAt === null || new Date(token.expiresAt).getTime() > Date.now());
}

/**
 * The four steps, from real state. `tokens` null is "not read" (still loading or refused), which
 * is never a tick. `linked` is the codes of real projects with a repository, or null when unread.
 */
export function setupSteps(input: {
  tokens: readonly TokenRow[] | null;
  rows: readonly PortfolioRow[];
  linked: readonly string[] | null;
}): SetupStep[] {
  const rows = realRows(input.rows);
  const used = (input.tokens ?? [])
    .filter((token) => token.lastUsedAt !== null)
    .sort((a, b) => String(b.lastUsedAt).localeCompare(String(a.lastUsedAt)));
  const unused = (input.tokens ?? []).filter((token) => token.lastUsedAt === null && live(token));
  const committed = rows
    .filter((row) => row.lastActivityAt !== null)
    .sort((a, b) => String(b.lastActivityAt).localeCompare(String(a.lastActivityAt)));
  const linked = rows.filter((row) => committed.includes(row) || (input.linked ?? []).includes(row.code));

  const agent = used[0];
  const latest = committed[0];
  const raw: Omit<SetupStep, 'state'>[] = [
    {
      key: 'agent',
      title: 'Connect an agent',
      done: agent !== undefined,
      evidence:
        agent !== undefined
          ? `Token “${agent.name}” ${agent.prefix}… · ${agent.scopes.join(', ')} · last call ${relativeDay(agent.lastUsedAt ?? '')}, from its last-used time`
          : input.tokens === null
            ? 'Not read yet.'
            : unused.length > 0
              ? `Token “${unused[0]?.name ?? ''}” is issued and waiting for its first call.`
              : 'No agent has called Foreman yet. Issue a token, or use the remote MCP.',
    },
    {
      key: 'project',
      title: 'Create or import a project',
      done: rows.length > 0,
      evidence:
        rows.length > 0
          ? listJoin(rows.slice(0, 3).map((row) => `${row.code} ${row.name}`)) + (rows.length > 3 ? ` and ${String(rows.length - 3)} more` : '')
          : 'No project yet. The samples do not count: they were seeded, not planned.',
    },
    {
      key: 'repo',
      title: 'Link its repository',
      done: linked.length > 0,
      evidence:
        linked.length > 0
          ? `${listJoin(linked.slice(0, 3).map((row) => row.code))} ${linked.length === 1 ? 'has' : 'have'} a repository linked.`
          : 'No project has a repository yet. A link is how Foreman reads commits, CI and deployments — the reality half of the ledger.',
    },
    {
      key: 'commit',
      title: 'See the first commit',
      done: latest !== undefined,
      evidence:
        latest !== undefined
          ? `${latest.code}’s latest commit was ingested ${relativeDay(latest.lastActivityAt ?? '')}.`
          : 'Ticks when the first push to a linked repository is ingested.',
    },
  ];
  const next = raw.findIndex((step) => !step.done);
  return raw.map((step, index) => ({
    ...step,
    state: step.done ? 'done' : index === next ? 'next' : 'waiting',
  }));
}

/** "2 of 4 done". */
export function setupSummary(steps: readonly SetupStep[]): string {
  return `${String(steps.filter((step) => step.done).length)} of ${String(steps.length)} done`;
}

function stateWord(step: SetupStep, steps: readonly SetupStep[]): string {
  if (step.state === 'done') return 'done';
  if (step.state === 'next') return 'next';
  const blocking = steps.findIndex((other) => other.state === 'next');
  return `waiting on step ${String(blocking + 1)}`;
}

/** How a repository is linked today: the API, with a write token — not a click to undo. */
function linkRepoSnippet(origin: string, code: string): string {
  return [
    `curl -X POST ${origin}/api/projects/${code}/repos \\`,
    '  -H "Authorization: Bearer $FOREMAN_WRITE_TOKEN" \\',
    "  -H 'content-type: application/json' \\",
    `  -d '{"fullName":"owner/name"}'`,
  ].join('\n');
}

function StepAction({ step, rows }: { step: SetupStep; rows: readonly PortfolioRow[] }) {
  if (step.key === 'agent') {
    return (
      <Button variant={step.done ? 'secondary' : 'primary'} onClick={() => { navigate('/tokens'); }}>
        {step.done ? 'Connect another' : 'Connect an agent'}
      </Button>
    );
  }
  if (step.key === 'project') {
    return (
      <Cluster gap="8" align="center">
        <Button variant={step.done ? 'secondary' : 'primary'} onClick={() => { navigate('/projects?new=1'); }}>
          New project
        </Button>
        <Button variant="secondary" onClick={() => { navigate('/projects?import=1'); }}>
          Import…
        </Button>
      </Cluster>
    );
  }
  if (step.key === 'repo' && !step.done) {
    const first = realRows(rows)[0];
    if (first === undefined) return null;
    return <Snippet label={`the command that links a repository to ${first.code}`} text={linkRepoSnippet(typeof window === 'undefined' ? '' : window.location.origin, first.code)} />;
  }
  return null;
}

/** The checklist itself: four steps, each with its word, its evidence and its way forward. */
export function SetupChecklist({ steps, rows }: { steps: readonly SetupStep[]; rows: readonly PortfolioRow[] }) {
  return (
    <Section title="Set Foreman up" description={`${setupSummary(steps)}. Each tick is read from what Foreman can see, not from a click.`} surface="card">
      <ol className="fm-setup">
        {steps.map((step, index) => (
          <li key={step.key} className={`fm-setup__step fm-setup__step--${step.state}`}>
            <span className="fm-setup__mark" aria-hidden="true">
              {step.done ? <Check /> : String(index + 1)}
            </span>
            <Stack gap="8">
              <Cluster gap="8" align="center">
                <span className="fm-setup__title">{step.title}</span>
                <Pill tone="neutral">{stateWord(step, steps)}</Pill>
              </Cluster>
              <span className="fm-setup__evidence">{step.evidence}</span>
              {step.state !== 'waiting' && <StepAction step={step} rows={rows} />}
            </Stack>
          </li>
        ))}
      </ol>
    </Section>
  );
}

/**
 * The samples, said and removable: a soft delete through the project delete path, one Undo for
 * all of them (`useMutate`). The server refuses any project that is not a sample.
 */
export function SampleNotice({ samples, onChanged }: { samples: readonly PortfolioRow[]; onChanged: () => void }) {
  const { mutate, pending } = useMutate();
  if (samples.length === 0) return null;
  const names = listJoin(samples.map((row) => `${row.name} ${row.code}`));
  const codes = listJoin(samples.map((row) => row.code));
  return (
    <Card padding="md">
      <Cluster gap="16" align="center" justify="between">
        <Stack gap="4">
          <Cluster gap="8" align="center">
            <Pill tone="neutral">Sample</Pill>
            <strong>{samples.length === 1 ? 'A sample project' : 'Sample projects'}</strong>
          </Cluster>
          <span className="fm-muted">
            {names} {samples.length === 1 ? 'was' : 'were'} seeded to show what a full plan looks like. Labelled
            everywhere, and counted in no figure on Home.
          </span>
        </Stack>
        <Button
          loading={pending}
          onClick={() => {
            void mutate({
              subject: codes,
              run: async () => {
                // One request a project. Whatever was removed is reported and undoable even if a
                // later one is refused; only when none went is it a failure.
                const auditEventIds: string[] = [];
                let refusal: Error | null = null;
                for (const row of samples) {
                  try {
                    const { auditEventIds: ids } = await foreman.removeSampleProject(row.code);
                    auditEventIds.push(...ids);
                  } catch (caught) {
                    refusal = caught instanceof Error ? caught : new Error(String(caught));
                  }
                }
                if (auditEventIds.length === 0 && refusal !== null) throw refusal;
                return { auditEventIds };
              },
              message: () => `Removed the sample ${samples.length === 1 ? 'project' : 'projects'} ${codes}`,
              undone: `Undone — ${codes} ${samples.length === 1 ? 'is' : 'are'} back`,
              refresh: onChanged,
            });
          }}
        >
          Remove sample projects
        </Button>
      </Cluster>
    </Card>
  );
}

/** What Home will show once there is something real to measure — none of it shown as clear yet. */
function WhatHomeWillShow() {
  return (
    <Section title="What Home will show" description="Per project, once there is one. None of it is measurable yet, so none of it is shown as clear." surface="card">
      <ul className="fm-figure-list">
        <li><span>Drift</span><span className="fm-muted">not measurable yet</span></li>
        <li><span>Blocked work</span><span className="fm-muted">not measurable yet</span></li>
        <li><span>Critical + high</span><span className="fm-muted">no audit run yet</span></li>
        <li><span>CI</span><span className="fm-muted">needs a linked repository</span></li>
      </ul>
    </Section>
  );
}

/**
 * The steps, read: the token list for step 1, each real project's repositories for step 3 while
 * no commit has been seen (a commit implies its repository). Null until both reads have answered,
 * so nothing is shown as pending that has not been looked at. `enabled` false reads nothing.
 */
export function useSetupSteps(rows: readonly PortfolioRow[], enabled = true): SetupStep[] | null {
  const tokens = useAsync(() => (enabled ? foreman.tokens().then((page) => page.items) : Promise.resolve(null)), [enabled]);
  const real = realRows(rows);
  const needRepos = enabled && real.length > 0 && real.every((row) => row.lastActivityAt === null);
  const codes = real.map((row) => row.code).join(',');
  const repos = useAsync(
    () =>
      needRepos
        ? Promise.all(
            real
              .slice(0, 20)
              .map((row) => foreman.repos(row.code).then((page) => (page.items.length > 0 ? [row.code] : []))),
          ).then((found) => found.flat())
        : Promise.resolve([] as string[]),
    [codes, needRepos],
  );
  if (!enabled || repos.state.status === 'loading' || tokens.state.status === 'loading') return null;
  return setupSteps({
    // A refused read (a role without the token list) is "not read", never a tick.
    tokens: tokens.state.status === 'ready' ? tokens.state.value : null,
    rows,
    linked: repos.state.status === 'ready' ? repos.state.value : null,
  });
}

/** Where "Not now" on the Finish setting up card is remembered, per browser. */
export const SETUP_DISMISSED_KEY = 'foreman.home.setup-dismissed';

export function readSetupDismissed(): boolean {
  try {
    return window.localStorage.getItem(SETUP_DISMISSED_KEY) === '1';
  } catch {
    // Storage refused (a private window, a policy): the card shows, and Not now hides it until reload.
    return false;
  }
}

export function writeSetupDismissed(): void {
  try {
    window.localStorage.setItem(SETUP_DISMISSED_KEY, '1');
  } catch {
    // As above: remembered for this page only.
  }
}

/** Whether Home shows the Finish setting up card: some step pending, and not put off here. */
export function showFinishCard(steps: readonly SetupStep[] | null, dismissed: boolean): boolean {
  return !dismissed && steps !== null && steps.some((step) => !step.done);
}

/**
 * Home once there is a real project and setup is not finished (board D-09): one line — how far,
 * and what is next — that opens to the checklist, and "Not now", remembered in this browser. Above
 * the ledger, so Home is the dashboard first. Not a heading: the page's sections are its groups.
 */
export function FinishSettingUp({ rows }: { rows: readonly PortfolioRow[] }) {
  const [dismissed, setDismissed] = useState(readSetupDismissed);
  const [open, setOpen] = useState(false);
  const steps = useSetupSteps(rows, !dismissed);
  const bodyId = useId();
  if (steps === null || !showFinishCard(steps, dismissed)) return null;
  const next = steps.find((step) => step.state === 'next');
  return (
    <div role="region" aria-label="Finish setting up" className="fm-finish">
      <Card padding="sm">
        <Stack gap="12">
          <Cluster gap="12" align="center" justify="between">
            <span>
              <strong>Finish setting up</strong>
              <span className="fm-muted">
                {' · '}
                {setupSummary(steps)}
                {next === undefined ? '' : ` · next: ${next.title.toLowerCase()}`}
              </span>
            </span>
            <Cluster gap="8" align="center">
              <Button
                variant="ghost"
                aria-expanded={open}
                aria-controls={bodyId}
                onClick={() => { setOpen(!open); }}
              >
                {open ? 'Hide the steps' : 'Show the steps'}
              </Button>
              <Button
                variant="ghost"
                onClick={() => {
                  writeSetupDismissed();
                  setDismissed(true);
                }}
              >
                Not now
              </Button>
            </Cluster>
          </Cluster>
          <div id={bodyId} hidden={!open}>
            {open && <SetupChecklist steps={steps} rows={rows} />}
          </div>
        </Stack>
      </Card>
    </div>
  );
}

/**
 * Home with no real project: the checklist, the samples, and what Home will show.
 */
export function FirstRun({ rows, onChanged }: { rows: readonly PortfolioRow[]; onChanged: () => void }) {
  const steps =
    useSetupSteps(rows) ?? setupSteps({ tokens: null, rows, linked: null });
  return (
    <Stack gap="24">
      <SetupChecklist steps={steps} rows={rows} />
      <SampleNotice samples={sampleRows(rows)} onChanged={onChanged} />
      <WhatHomeWillShow />
    </Stack>
  );
}
