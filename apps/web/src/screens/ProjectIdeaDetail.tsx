import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import {
  Alert,
  Button,
  Card,
  Checkbox,
  Cluster,
  EmptyState,
  FormActions,
  Grid,
  Input,
  Page,
  PageHeader,
  Section,
  SegmentedControl,
  Skeleton,
  Stack,
  Textarea,
} from '@d3cloud/ui';
import { IDEA_SECTIONS } from '@foreman/shared';
import {
  foreman,
  type ChecklistItem,
  type CommentRow,
  type IdeaLinkRow,
  type ProjectIdeaDetail as Detail,
  type ProjectIdeaPatch,
  type ScoreSummary,
} from '../lib/api';
import { useAsync } from '../lib/useAsync';
import { draftSize, useDraftGuard, useMutate } from '../lib/mutate';
import { navigate } from '../lib/router';
import { listJoin } from '../lib/groups';
import { HistoryDrawer } from '../components/HistoryDrawer';
import { useMode, useMoney, useReviews, useSession } from '../lib/session';
import { Markdown } from '../components/Markdown';
import { Pill } from '../ui/viz';
import { relativeDay } from '../ui/tone';
import { MaturityBar, StarsControl } from '../ui/ideas';
import { FundIdea } from './BoardControls';
import { ALL, ConvertIdea, DECIDED_ELSEWHERE, ideaTone, ProjectIdeaForm } from './ProjectIdeas';

/**
 * One project idea, on a page of its own (FRM-ADR-017, FRM-REQ-173 … FRM-REQ-178).
 *
 * An idea used to be a card: a title and a line. This is where it grows into something worth
 * converting, and the shape of the page is the argument for how that should happen.
 *
 * - **A canvas of named questions, not a blank page.** Foreman's anti-features rule out a freeform
 *   wiki, and a blank page per idea would be exactly that. Five sections that each ask something
 *   specific — the problem, who it is for, how it might work, why now, what would kill it — plus
 *   one small scratchpad. The prompts are the point: an empty section says what is still unknown.
 * - **The lists you actually work through**: open questions, next steps, links, related ideas.
 * - **A thoughts log**, dated, because an idea is thought about over weeks and the order matters.
 * - **Four readings at the top** — how thought through, how wanted, impact against effort, and how
 *   recently it has had any attention — so the page answers "where is this" before it is read.
 *
 * Everything saves as it is changed. There is no Save for the page, because a page of eight
 * separately edited parts with one button is a page where edits are lost to a closed tab.
 *
 * Each save lands in place and its toast offers Undo (FRM-T-18.4); History lists every change with
 * an Undo on each one the server can reverse. Delete is soft, so it acts at once — Undo brings the
 * idea back and returns here. An open section editor asks before Escape throws a draft away.
 */

const PITCH = {
  key: 'pitch',
  heading: 'The pitch',
  prompt: 'One or two sentences. What it is, and why anybody would want it.',
} as const;

/** Where a related human ID lives in the console. Anything unrecognised goes to search. */
function entityHref(id: string): string {
  if (/^PI-\d+$/.test(id)) return `/project-ideas/${id}`;
  if (/^[A-Z][A-Z0-9]{1,7}$/.test(id)) return `/projects/${id}`;
  const type = id.split('-')[1];
  if (type === 'REQ') return `/requirements/${id}`;
  if (type === 'T') return `/tasks/${id}`;
  if (type === 'CR' || type === 'DA' || type === 'FR' || type === 'API') return `/findings/${id}`;
  return `/search?q=${encodeURIComponent(id)}`;
}

/** What a patch changed, in the page's own words — for the toast. */
export function patchLabels(patch: ProjectIdeaPatch): string[] {
  const names: Record<string, string> = {
    pitch: 'the pitch',
    excitement: 'how much you want it',
    tags: 'tags',
    questions: 'open questions',
    nextSteps: 'next steps',
    links: 'links',
    related: 'related',
    title: 'the title',
    status: 'the status',
    reason: 'the reason',
  };
  for (const section of IDEA_SECTIONS) names[section.key] = section.heading.toLowerCase();
  return Object.keys(patch).map((key) => names[key] ?? key);
}

/** An 8-character id for a new list item: stable across edits, cheap, and never shown. */
const newId = () => crypto.randomUUID().slice(0, 8);

export function ProjectIdeaDetail({ humanId }: { humanId: string }) {
  const board = useMode() === 'board';
  const reviews = useReviews();
  const money = useMoney();
  const { user } = useSession();
  // `refresh` re-reads in place; the page also keeps its own copy below, so nothing flashes.
  const { state, refresh } = useAsync(() => foreman.projectIdea(humanId), [humanId]);
  const { mutate } = useMutate();

  // Held locally as well as loaded, so a save updates the page from the server's answer rather
  // than refetching — a refetch would flash the skeleton over the section somebody just wrote.
  const [idea, setIdea] = useState<Detail | null>(null);
  useEffect(() => {
    if (state.status === 'ready') setIdea(state.value);
  }, [state]);

  const [saveError, setSaveError] = useState<string | null>(null);

  const save = useCallback(
    async (patch: ProjectIdeaPatch): Promise<boolean> => {
      setSaveError(null);
      const outcome = await mutate({
        subject: humanId,
        run: () => foreman.updateProjectIdea(humanId, patch),
        message: () => `Saved ${humanId} — ${listJoin(patchLabels(patch))}`,
        // The server's answer is the page: no refetch, so nothing flashes over what was written.
        apply: setIdea,
        onUndone: refresh,
        failure: 'inline',
      });
      if (!outcome.ok && outcome.inFlight !== true) setSaveError(outcome.message);
      return outcome.ok;
    },
    [humanId, mutate, refresh],
  );

  const remove = () => {
    void mutate({
      subject: humanId,
      run: () => foreman.deleteProjectIdea(humanId),
      message: () => `${humanId} deleted`,
      // Soft, and undoable: it acts at once, and Undo brings it back and returns to it.
      apply: () => {
        navigate('/project-ideas');
      },
      undone: `Undone — ${humanId} is back`,
      onUndone: (report) => {
        if (report.refused.length === 0) navigate(`/project-ideas/${humanId}`);
      },
    });
  };

  if (idea === null) {
    return (
      <Page>
        {state.status === 'error' ? (
          <EmptyState kind="error" heading={`${humanId} did not load`}>
            {state.message}
          </EmptyState>
        ) : (
          <Skeleton lines={12} />
        )}
      </Page>
    );
  }

  const settled = DECIDED_ELSEWHERE.includes(idea.status);
  const mine = idea.submittedBy?.id === user.id;
  // A submitter shapes their own idea; a reviewer shapes any; nobody reshapes one that has been
  // funded or become a project — it is the record of what was decided on.
  const canEdit = !settled && (reviews || mine);
  const statusLabel = ALL.find((s) => s.value === idea.status)?.label ?? idea.status;

  return (
    <Page>
      <PageHeader
        title={idea.title}
        description={
          board && idea.submittedBy !== null
            ? `${idea.humanId} · submitted by ${idea.submittedBy.displayName} ${relativeDay(idea.createdAt)}`
            : `${idea.humanId} · written down ${relativeDay(idea.createdAt)}`
        }
        back={<a href="/project-ideas">{board ? 'Submissions' : 'Project ideas'}</a>}
        actions={
          <Cluster gap="8" align="center">
            <Pill tone={ideaTone(idea.status)}>{statusLabel}</Pill>
            {canEdit && <ProjectIdeaForm idea={idea} onSaved={refresh} />}
            {board && reviews && !settled && <FundIdea idea={idea} onFunded={refresh} />}
            {!board && reviews && !settled && <ConvertIdea idea={idea} onConverted={refresh} />}
            <HistoryDrawer entity={idea.humanId} onUndone={refresh} />
            {canEdit && (
              <Button aria-label={`Delete ${idea.humanId}`} onClick={remove}>
                Delete
              </Button>
            )}
          </Cluster>
        }
      />

      <Stack gap="24">
        {saveError !== null && (
          <Alert tone="danger" title="That did not save" dynamic>
            {saveError}
          </Alert>
        )}

        <Outcome idea={idea} money={money} />

        <Grid minItemWidth="sm">
          <Card padding="md">
            <Stack gap="8">
              <span className="fm-stat__label">Thought through</span>
              <MaturityBar maturity={idea.maturity} />
              <span className="fm-stat__detail">
                {idea.maturity.filled === idea.maturity.total
                  ? 'Every question has an answer.'
                  : `Still blank: ${blankSections(idea).join(', ')}.`}
              </span>
            </Stack>
          </Card>

          <Card padding="md">
            <Stack gap="8">
              <span className="fm-stat__label">How much you want it</span>
              <StarsControl
                value={idea.excitement}
                disabled={!canEdit}
                onChange={(excitement) => { void save({ excitement }); }}
              />
              <span className="fm-stat__detail">
                Separate from how good it is. The two disagree more than anybody admits.
              </span>
            </Stack>
          </Card>

          {reviews && <Rating humanId={idea.humanId} board={board} disabled={settled} />}

          <Momentum idea={idea} />
        </Grid>

        <div className="fm-idea">
          <div className="fm-idea__main">
            <SectionCard
              heading={PITCH.heading}
              prompt={PITCH.prompt}
              value={idea.pitch}
              editable={canEdit}
              onSave={(text) => save({ pitch: text })}
            />
            {IDEA_SECTIONS.map((section) => (
              <SectionCard
                key={section.key}
                heading={section.heading}
                prompt={section.prompt}
                value={idea[section.key]}
                editable={canEdit}
                small={section.key === 'notes'}
                onSave={(text) => save({ [section.key]: text })}
              />
            ))}
          </div>

          {/* Its own grid area, so on a phone the lists come before it — they are what gets
              reached for while thinking; the log is what gets read afterwards. */}
          <div className="fm-idea__thoughts">
            <Thoughts humanId={idea.humanId} board={board} reviews={reviews} userId={user.id} />
          </div>

          <aside className="fm-idea__aside" aria-label="Lists">
            <Tags
              tags={idea.tags}
              editable={canEdit}
              onChange={(tags) => save({ tags })}
            />
            <Checklist
              title="Open questions"
              empty="What would you need to find out before starting?"
              items={idea.questions}
              doneLabel="answered"
              editable={canEdit}
              onChange={(questions) => save({ questions })}
            />
            <Checklist
              title="Next steps"
              empty="The smallest things that would move this forward."
              items={idea.nextSteps}
              doneLabel="done"
              editable={canEdit}
              onChange={(nextSteps) => save({ nextSteps })}
            />
            <Links links={idea.links} editable={canEdit} onChange={(links) => save({ links })} />
            <Related
              related={idea.related}
              self={idea.humanId}
              editable={canEdit}
              onChange={(related) => save({ related })}
            />
          </aside>
        </div>
      </Stack>
    </Page>
  );
}

/** Which of the maturity sections are still empty, by the names the canvas uses. */
function blankSections(idea: Detail): string[] {
  const blank: string[] = [];
  if (idea.pitch === null || idea.pitch.trim() === '') blank.push('the pitch');
  for (const section of IDEA_SECTIONS) {
    if (section.key === 'notes') continue;
    const value = idea[section.key];
    if (value === null || value.trim() === '') blank.push(section.heading.toLowerCase());
  }
  return blank;
}

/** What has been decided about this idea, and why — shown first, because it changes how the rest reads. */
function Outcome({ idea, money }: { idea: Detail; money: (cents: number | null) => string }) {
  if (idea.project !== null) {
    return (
      <Alert tone="info" title={`Became ${idea.project.code} — ${idea.project.name}`}>
        <Cluster gap="8" align="center">
          <span>
            Converted {relativeDay(idea.convertedAt)}. This canvas is the project’s discovery
            document, so the thinking carried over.
          </span>
          <a href={`/projects/${idea.project.code}/documents`}>Open the project’s documents</a>
        </Cluster>
      </Alert>
    );
  }
  if (idea.status === 'funded') {
    return (
      <Alert tone="info" title={`Funded — ${money(idea.fundedAmountCents)}`}>
        {idea.reason}
      </Alert>
    );
  }
  if ((idea.status === 'parked' || idea.status === 'rejected') && idea.reason !== null) {
    return (
      <Alert
        tone={idea.status === 'rejected' ? 'danger' : 'warning'}
        title={idea.status === 'rejected' ? 'Decided against' : 'Parked — deliberately not now'}
      >
        {idea.reason}
      </Alert>
    );
  }
  return null;
}

// ─── The canvas ──────────────────────────────────────────────────────────────

/**
 * One named section: rendered Markdown, or its prompt when blank, and an editor on demand.
 *
 * The prompt shows when the section is empty rather than as placeholder text inside a box,
 * because an empty section is information — it says what is not known yet — and a placeholder
 * disappears the moment somebody starts typing the answer to it.
 */
function SectionCard({
  heading,
  prompt,
  value,
  editable,
  small = false,
  onSave,
}: {
  heading: string;
  prompt: string;
  value: string | null;
  editable: boolean;
  small?: boolean;
  onSave: (text: string) => Promise<boolean>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value ?? '');
  const [busy, setBusy] = useState(false);
  const written = value !== null && value.trim().length > 0;
  const allowClose = useDraftGuard(editing ? draftSize({ text: value ?? '' }, { text: draft }) : 0, heading);

  // A ref, not `busy`: two ⌘↵ in one tick both read the state from before either render.
  const saving = useRef(false);
  const commit = () => {
    if (saving.current) return;
    saving.current = true;
    setBusy(true);
    void onSave(draft).then((ok) => {
      saving.current = false;
      setBusy(false);
      if (ok) setEditing(false);
    });
  };

  const keys = (event: KeyboardEvent) => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      commit();
    }
    if (event.key === 'Escape') {
      // Escape is the easy key to hit by accident, so a draft asks first.
      if (!allowClose()) return;
      setDraft(value ?? '');
      setEditing(false);
    }
  };

  return (
    // A Section, so a region named by its heading, like every other block on this page — not the
    // hand-rolled heading this replaced.
    <Section
      title={heading}
      actions={
        editable && !editing ? (
          // Ghost: seven sections each with a solid Edit button is seven buttons louder than
          // the writing they sit beside.
          <Button
            variant="ghost"
            onClick={() => {
              setDraft(value ?? '');
              setEditing(true);
            }}
          >
            {written ? 'Edit' : 'Write'}
          </Button>
        ) : undefined
      }
    >
      {editing ? (
        <Stack gap="8">
          <p className="fm-muted">{prompt}</p>
          <Textarea
            aria-label={heading}
            rows={small ? 5 : 10}
            value={draft}
            autoFocus
            maxLength={20_000}
            onKeyDown={keys}
            onChange={(e) => { setDraft(e.target.value); }}
          />
          <Cluster gap="8" align="center" justify="between">
            <span className="fm-muted">
              Markdown, and ```mermaid``` diagrams. ⌘↵ saves, Esc cancels.
            </span>
            <FormActions>
              <Button
                type="button"
                onClick={() => {
                  setDraft(value ?? '');
                  setEditing(false);
                }}
              >
                Cancel
              </Button>
              <Button type="button" variant="primary" disabled={busy} onClick={commit}>
                {busy ? 'Saving…' : 'Save'}
              </Button>
            </FormActions>
          </Cluster>
        </Stack>
      ) : written ? (
        <div className="fm-markdown">
          <Markdown>{value}</Markdown>
        </div>
      ) : (
        <p className="fm-section__prompt">{prompt}</p>
      )}
    </Section>
  );
}

// ─── The four readings ───────────────────────────────────────────────────────

const SCALE = ['1', '2', '3', '4', '5'].map((v) => ({ value: v, label: v }));

/**
 * Impact against effort — your read, and on a board the board's.
 *
 * Saves when both have been chosen, not on the first click: a score of impact 5 with no effort yet
 * is not a score, and writing it would put a half-decided idea on the matrix.
 */
function Rating({ humanId, board, disabled }: { humanId: string; board: boolean; disabled: boolean }) {
  const { user } = useSession();
  const { state, refresh } = useAsync(() => foreman.scores(humanId), [humanId]);
  const { mutate } = useMutate();
  const mineSaved =
    state.status === 'ready' ? state.value.scores.find((s) => s.user.id === user.id) : undefined;

  const [impact, setImpact] = useState<string | null>(null);
  const [effort, setEffort] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const shownImpact = impact ?? (mineSaved === undefined ? '' : String(mineSaved.impact));
  const shownEffort = effort ?? (mineSaved === undefined ? '' : String(mineSaved.effort));

  const persist = (nextImpact: string, nextEffort: string) => {
    if (nextImpact === '' || nextEffort === '') return;
    setError(null);
    void mutate({
      subject: humanId,
      run: () => foreman.setScore(humanId, { impact: Number(nextImpact), effort: Number(nextEffort) }),
      message: () => `Rated ${humanId}: impact ${nextImpact}, effort ${nextEffort}`,
      // A score is not in what the server can undo; a new rating replaces it.
      undoable: false,
      failure: 'inline',
    }).then((outcome) => {
      if (!outcome.ok) {
        if (outcome.inFlight !== true) setError(outcome.message);
        return;
      }
      setImpact(null);
      setEffort(null);
      refresh();
    });
  };

  const summary: ScoreSummary | null = state.status === 'ready' ? state.value.summary : null;

  return (
    <Card padding="md">
      <Stack gap="8">
        <span className="fm-stat__label">{board ? 'Your read' : 'Impact × effort'}</span>
        <Cluster gap="8" align="center">
          <span className="fm-rating__axis">Impact</span>
          <SegmentedControl
            aria-label="Impact, one to five"
            size="sm"
            items={SCALE}
            value={shownImpact}
            onValueChange={(v) => {
              if (disabled) return;
              setImpact(v);
              persist(v, shownEffort);
            }}
          />
        </Cluster>
        <Cluster gap="8" align="center">
          <span className="fm-rating__axis">Effort</span>
          <SegmentedControl
            aria-label="Effort, one to five"
            size="sm"
            items={SCALE}
            value={shownEffort}
            onValueChange={(v) => {
              if (disabled) return;
              setEffort(v);
              persist(shownImpact, v);
            }}
          />
        </Cluster>
        {error !== null && <span className="fm-error">{error}</span>}
        <span className="fm-stat__detail">
          {board && summary !== null && summary.count > 0
            ? `Board: ${String(summary.impact)}↑ / ${String(summary.effort)}↓ from ${String(summary.count)} ${summary.count === 1 ? 'reviewer' : 'reviewers'}`
            : summary !== null && summary.ratio !== null
              ? `${String(summary.ratio)}× — ${quadrant(summary.impact ?? 0, summary.effort ?? 0)}`
              : '1 is marginal or small; 5 is transformative or large.'}
        </span>
      </Stack>
    </Card>
  );
}

/** The matrix's quadrant for a rating, named the same way the chart names it. */
function quadrant(impact: number, effort: number): string {
  if (impact >= 3 && effort < 3) return 'a quick win';
  if (impact >= 3) return 'a big bet';
  if (effort < 3) return 'a fill-in';
  return 'a money pit';
}

/** How recently this idea has had any attention — the reading that says whether it is alive. */
function Momentum({ idea }: { idea: Detail }) {
  const open = idea.questions.filter((q) => !q.done).length;
  const thoughts = idea._count.comments;
  return (
    <Card padding="md">
      <Stack gap="8">
        <span className="fm-stat__label">Momentum</span>
        <span className="fm-stat__value">{relativeDay(idea.updatedAt)}</span>
        <span className="fm-stat__detail">
          Last touched. {thoughts} {thoughts === 1 ? 'thought' : 'thoughts'}
          {open > 0 ? `, ${String(open)} open ${open === 1 ? 'question' : 'questions'}` : ''}.
        </span>
      </Stack>
    </Card>
  );
}

// ─── The lists ───────────────────────────────────────────────────────────────

function AsideCard({ title, meta, children }: { title: string; meta?: string; children: ReactNode }) {
  return (
    <Section title={title} actions={meta === undefined ? undefined : <span className="fm-muted">{meta}</span>}>
      {children}
    </Section>
  );
}

/** One text field that adds on Enter — the add row every list here shares. */
function AddRow({
  label,
  onAdd,
  placeholder,
}: {
  label: string;
  onAdd: (text: string) => void;
  placeholder?: string;
}) {
  const [text, setText] = useState('');
  const add = () => {
    const value = text.trim();
    if (value.length === 0) return;
    onAdd(value);
    setText('');
  };
  return (
    <Cluster gap="8" align="center">
      <div className="fm-grow">
        <Input
          aria-label={label}
          value={text}
          {...(placeholder === undefined ? {} : { placeholder })}
          onChange={(e) => { setText(e.target.value); }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              add();
            }
          }}
        />
      </div>
      <Button type="button" onClick={add} disabled={text.trim().length === 0}>
        Add
      </Button>
    </Cluster>
  );
}

function Checklist({
  title,
  empty,
  items,
  doneLabel,
  editable,
  onChange,
}: {
  title: string;
  empty: string;
  items: ChecklistItem[];
  doneLabel: string;
  editable: boolean;
  onChange: (items: ChecklistItem[]) => Promise<boolean>;
}) {
  const done = items.filter((i) => i.done).length;
  return (
    <AsideCard
      title={title}
      {...(items.length > 0 ? { meta: `${String(done)} of ${String(items.length)} ${doneLabel}` } : {})}
    >
      {items.length === 0 && <p className="fm-section__prompt">{empty}</p>}
      <ul className="fm-checklist">
        {items.map((item) => (
          <li key={item.id} className="fm-checklist__item">
            <Checkbox
              label={item.text}
              checked={item.done}
              disabled={!editable}
              onCheckedChange={(checked) => {
                void onChange(items.map((i) => (i.id === item.id ? { ...i, done: checked === true } : i)));
              }}
            />
            {editable && (
              <button
                type="button"
                className="fm-remove"
                aria-label={`Remove “${item.text}”`}
                onClick={() => { void onChange(items.filter((i) => i.id !== item.id)); }}
              >
                ×
              </button>
            )}
          </li>
        ))}
      </ul>
      {editable && (
        <AddRow
          label={`Add to ${title.toLowerCase()}`}
          onAdd={(text) => { void onChange([...items, { id: newId(), text, done: false }]); }}
        />
      )}
    </AsideCard>
  );
}

function Tags({
  tags,
  editable,
  onChange,
}: {
  tags: string[];
  editable: boolean;
  onChange: (tags: string[]) => Promise<boolean>;
}) {
  return (
    <AsideCard title="Tags">
      {tags.length === 0 && (
        <p className="fm-section__prompt">Group it with others — a domain, a platform, a theme.</p>
      )}
      {tags.length > 0 && (
        <Cluster gap="4">
          {tags.map((t) => (
            <span key={t} className="fm-tag fm-tag--static">
              {t}
              {editable && (
                <button
                  type="button"
                  className="fm-tag__remove"
                  aria-label={`Remove tag ${t}`}
                  onClick={() => { void onChange(tags.filter((x) => x !== t)); }}
                >
                  ×
                </button>
              )}
            </span>
          ))}
        </Cluster>
      )}
      {editable && (
        <AddRow
          label="Add a tag"
          placeholder="e.g. home-lab"
          onAdd={(text) => { void onChange([...tags, text]); }}
        />
      )}
    </AsideCard>
  );
}

function Links({
  links,
  editable,
  onChange,
}: {
  links: IdeaLinkRow[];
  editable: boolean;
  onChange: (links: IdeaLinkRow[]) => Promise<boolean>;
}) {
  const [label, setLabel] = useState('');
  const [url, setUrl] = useState('');
  const add = () => {
    if (label.trim() === '' || url.trim() === '') return;
    void onChange([...links, { id: newId(), label: label.trim(), url: url.trim() }]).then((ok) => {
      if (ok) {
        setLabel('');
        setUrl('');
      }
    });
  };

  return (
    <AsideCard title="Links">
      {links.length === 0 && (
        <p className="fm-section__prompt">Prior art, inspiration, the thread that started it.</p>
      )}
      <ul className="fm-checklist">
        {links.map((l) => (
          <li key={l.id} className="fm-checklist__item">
            <a href={l.url} target="_blank" rel="noreferrer noopener">
              {l.label}
            </a>
            {editable && (
              <button
                type="button"
                className="fm-remove"
                aria-label={`Remove link ${l.label}`}
                onClick={() => { void onChange(links.filter((x) => x.id !== l.id)); }}
              >
                ×
              </button>
            )}
          </li>
        ))}
      </ul>
      {editable && (
        <Stack gap="8">
          <Input aria-label="Link label" placeholder="Label" value={label} onChange={(e) => { setLabel(e.target.value); }} />
          <Cluster gap="8" align="center">
            <div className="fm-grow">
              <Input
                aria-label="Link URL"
                placeholder="https://…"
                value={url}
                onChange={(e) => { setUrl(e.target.value); }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    add();
                  }
                }}
              />
            </div>
            <Button type="button" onClick={add} disabled={label.trim() === '' || url.trim() === ''}>
              Add
            </Button>
          </Cluster>
        </Stack>
      )}
    </AsideCard>
  );
}

function Related({
  related,
  self,
  editable,
  onChange,
}: {
  related: string[];
  self: string;
  editable: boolean;
  onChange: (related: string[]) => Promise<boolean>;
}) {
  return (
    <AsideCard title="Related">
      {related.length === 0 && (
        <p className="fm-section__prompt">
          Ideas or projects this builds on, competes with, or would replace — PI-003, BND, BND-REQ-012.
        </p>
      )}
      <ul className="fm-checklist">
        {related.map((id) => (
          <li key={id} className="fm-checklist__item">
            <a href={entityHref(id)} className="fm-item__id">
              {id}
            </a>
            {editable && (
              <button
                type="button"
                className="fm-remove"
                aria-label={`Remove ${id}`}
                onClick={() => { void onChange(related.filter((x) => x !== id)); }}
              >
                ×
              </button>
            )}
          </li>
        ))}
      </ul>
      {editable && (
        <AddRow
          label="Add a related ID"
          placeholder="PI-003 or BND-REQ-012"
          onAdd={(text) => {
            const id = text.toUpperCase();
            if (id !== self) void onChange([...related, id]);
          }}
        />
      )}
    </AsideCard>
  );
}

// ─── Thoughts ────────────────────────────────────────────────────────────────

/**
 * A dated log of what you thought about this idea, newest first.
 *
 * On a board the same record is the discussion, with a board-only half; on a solo instance it is
 * your own running notes. Each is dated because an idea is thought about over weeks, and "I
 * changed my mind about the audience on the 14th" is worth more than the final answer alone.
 */
function Thoughts({
  humanId,
  board,
  reviews,
  userId,
}: {
  humanId: string;
  board: boolean;
  reviews: boolean;
  userId: string;
}) {
  const { state, refresh } = useAsync(() => foreman.comments(humanId), [humanId]);
  const { mutate, pending: busy } = useMutate();

  const [body, setBody] = useState('');
  const [internal, setInternal] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A half-written thought survives nothing but this: closing the tab asks first.
  useDraftGuard(body.trim().length, board ? 'the discussion' : 'a thought');

  // One post per press: a second ⌘↵ before the first lands is ignored, not stored twice. A ref,
  // because two key presses in one tick both see the state from before either render.
  const posting = useRef(false);
  const post = () => {
    if (posting.current || busy || body.trim().length === 0) return;
    posting.current = true;
    setError(null);
    void mutate({
      subject: humanId,
      run: () => foreman.addComment(humanId, { body, internal }),
      message: () => (board ? 'Posted' : 'Thought added'),
      refresh,
      // A thought is not in what the server can undo; Withdraw is how one is taken back.
      undoable: false,
      failure: 'inline',
    }).then((outcome) => {
      posting.current = false;
      if (!outcome.ok) {
        if (outcome.inFlight !== true) setError(outcome.message);
        return;
      }
      setBody('');
      setInternal(false);
    });
  };

  const items = state.status === 'ready' ? [...state.value.items].reverse() : [];

  return (
    // A Section, so a region named by its heading, like every other block on this page.
    <Section title={board ? 'Discussion' : 'Thoughts'}>
      <Stack gap="8">
        {error !== null && (
          <Alert tone="danger" title="That did not post" dynamic>
            {error}
          </Alert>
        )}
        <Textarea
          aria-label={board ? 'Add to the discussion' : 'Add a thought'}
          rows={3}
          value={body}
          maxLength={4000}
          placeholder={board ? 'Say something about this submission…' : 'What are you thinking about it today?'}
          onChange={(e) => { setBody(e.target.value); }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              post();
            }
          }}
        />
        <Cluster gap="8" align="center" justify="between">
          {board && reviews ? (
            <Checkbox
              label="Board only — the submitter will not see this"
              checked={internal}
              onCheckedChange={(checked) => { setInternal(checked === true); }}
            />
          ) : (
            <span className="fm-muted">Markdown works. ⌘↵ posts.</span>
          )}
          <Button type="button" variant="primary" disabled={busy || body.trim() === ''} onClick={post}>
            {busy ? 'Posting…' : board ? 'Post' : 'Add thought'}
          </Button>
        </Cluster>
      </Stack>

      {state.status === 'loading' && <Skeleton lines={3} />}
      {state.status === 'ready' && items.length === 0 && (
        <p className="fm-section__prompt">
          {board ? 'Nothing said yet.' : 'Nothing yet. A line a day is how an idea gets thought through.'}
        </p>
      )}
      <ol className="fm-thoughts">
        {items.map((c) => (
          <Thought key={c.id} humanId={humanId} thought={c} mine={c.user.id === userId} board={board} onChanged={refresh} />
        ))}
      </ol>
    </Section>
  );
}

function Thought({
  humanId,
  thought,
  mine,
  board,
  onChanged,
}: {
  humanId: string;
  thought: CommentRow;
  mine: boolean;
  board: boolean;
  onChanged: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(thought.body);
  const { mutate } = useMutate();
  useDraftGuard(editing ? draftSize({ body: thought.body }, { body: draft }) : 0, 'this thought');

  const save = () => {
    void mutate({
      subject: 'The thought',
      run: () => foreman.editComment(humanId, thought.id, draft),
      message: () => 'Thought reworded',
      refresh: onChanged,
      undoable: false,
    }).then((outcome) => {
      if (outcome.ok) setEditing(false);
    });
  };

  const withdraw = () => {
    // The server cannot put a withdrawn thought back, so this is the one place here that asks.
    if (!window.confirm('Withdraw this thought? This cannot be undone.')) return;
    void mutate({
      subject: 'The thought',
      run: () => foreman.deleteComment(humanId, thought.id),
      message: () => 'Thought withdrawn',
      refresh: onChanged,
      undoable: false,
    });
  };

  return (
    <li className={thought.internal ? 'fm-thought fm-thought--internal' : 'fm-thought'}>
      <Stack gap="4">
        <Cluster gap="8" align="center" justify="between">
          <span className="fm-muted">
            {board ? `${thought.user.displayName} · ` : ''}
            <time dateTime={thought.createdAt}>{relativeDay(thought.createdAt)}</time>
            {thought.internal && (
              <>
                {' '}
                <Pill tone="warning">board only</Pill>
              </>
            )}
          </span>
          {mine && !editing && (
            <Cluster gap="4">
              <Button variant="ghost" onClick={() => { setDraft(thought.body); setEditing(true); }}>Edit</Button>
              <Button
                variant="ghost"
                onClick={withdraw}
              >
                Withdraw
              </Button>
            </Cluster>
          )}
        </Cluster>
        {editing ? (
          <Stack gap="8">
            <Textarea aria-label="Reword this thought" rows={3} value={draft} onChange={(e) => { setDraft(e.target.value); }} />
            <FormActions>
              <Button type="button" onClick={() => { setEditing(false); }}>Cancel</Button>
              <Button type="button" variant="primary" disabled={draft.trim() === ''} onClick={save}>Save</Button>
            </FormActions>
          </Stack>
        ) : (
          <div className="fm-markdown">
            <Markdown>{thought.body}</Markdown>
          </div>
        )}
      </Stack>
    </li>
  );
}
