/**
 * The console's one way to reach the API.
 *
 * Same origin — the server serves this bundle — so the session cookie travels on its own and there
 * is no CORS, no token in `localStorage`, and nothing for a script on the page to steal.
 */

import {
  AUDIT_EVENT_ID_HEADER,
  AUDIT_EVENT_IDS_HEADER,
  type AuditEventsResponse,
  type AuditEventUndoability,
  type Group,
  type GroupAccent,
  type GroupDetail,
  type GroupListing,
  type Screen,
  type ScreenDetail,
  type ScreenProposalCreate,
  type ScreenVerdict,
  type ScreenVerdictKind,
  type ScreenVersion,
} from '@foreman/shared';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/**
 * A read that keeps the version with the body.
 *
 * `If-Match` is how a concurrent edit becomes visible instead of silently winning (FRM-REQ-146),
 * and the version is only in the response header — so any screen that intends to write back has to
 * take it at read time or it has nothing to send.
 *
 * Deliberately not generic: the one caller knows what it is reading, and a type parameter used
 * only in the return position is an unchecked cast wearing a signature.
 */
async function requestWithEtag(path: string): Promise<{ body: unknown; etag: string | null }> {
  const res = await fetch(path, { credentials: 'same-origin' });
  const text = await res.text();
  const body: unknown = text.length > 0 ? JSON.parse(text) : undefined;

  if (!res.ok) {
    const message =
      typeof body === 'object' && body !== null && 'error' in body
        ? String(body.error)
        : `request failed with ${String(res.status)}`;
    throw new ApiError(res.status, message, body);
  }
  return { body, etag: res.headers.get('etag') };
}

/**
 * The audit events a DELETE recorded. A 204 has no body, so the server names them in
 * `Audit-Event-Ids` (comma-separated, the record's own first), with the first alone in
 * `Audit-Event-Id` for a client that reads only that (FRM-T-18.3).
 */
export function auditIdsFromHeaders(headers: Pick<Headers, 'get'>): string[] {
  const all = headers.get(AUDIT_EVENT_IDS_HEADER);
  if (all !== null && all.trim() !== '') {
    return all.split(',').map((id) => id.trim()).filter((id) => id.length > 0);
  }
  const own = headers.get(AUDIT_EVENT_ID_HEADER);
  return own === null || own.trim() === '' ? [] : [own.trim()];
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  // Headers may legally be an array of pairs, which does not spread into an object — it spreads
  // into indices, and the header silently disappears.
  const headers = new Headers(init.headers);
  // A multipart body sets its own content type, boundary included; naming JSON over it would make
  // the upload unreadable to the server.
  if (init.body !== undefined && !(init.body instanceof FormData)) {
    headers.set('content-type', 'application/json');
  }

  const res = await fetch(path, {
    ...init,
    headers,
    // Explicit, though same-origin is the default: this is the whole authentication story.
    credentials: 'same-origin',
  });

  // 204 has no body to parse. What it can carry is the audit events a DELETE recorded, in its
  // headers — so every caller of a 204 route gets those, and nothing else.
  if (res.status === 204) return { auditEventIds: auditIdsFromHeaders(res.headers) } as T;

  const text = await res.text();
  const body: unknown = text.length > 0 ? JSON.parse(text) : undefined;

  if (!res.ok) {
    const message =
      typeof body === 'object' && body !== null && 'error' in body
        ? String(body.error)
        : `request failed with ${String(res.status)}`;
    throw new ApiError(res.status, message, body);
  }
  return body as T;
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  patch: <T>(path: string, body: unknown) =>
    request<T>(path, { method: 'PATCH', body: JSON.stringify(body) }),
  getWithEtag: (path: string) => requestWithEtag(path),
  put: <T>(path: string, body: unknown, etag?: string | null) =>
    request<T>(path, {
      method: 'PUT',
      body: JSON.stringify(body),
      ...(etag === undefined || etag === null ? {} : { headers: { 'if-match': etag } }),
    }),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, {
      method: 'POST',
      // Spread rather than an undefined value: `exactOptionalPropertyTypes` distinguishes
      // "no body" from "a body that is undefined", and `RequestInit` accepts only the first.
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  /** A DELETE answers 204; what comes back is the audit events its headers named. */
  del: (path: string) => request<Deleted>(path, { method: 'DELETE' }),
  /** One file as multipart, in the field the blob route reads (FRM-REQ-190). */
  upload: <T>(path: string, field: string, file: Blob) => {
    const form = new FormData();
    form.append(field, file);
    return request<T>(path, { method: 'POST', body: form });
  },
};

export interface SessionUser {
  id: string;
  email: string;
  displayName: string;
  status: 'invited' | 'active' | 'suspended';
  role: 'admin' | 'reviewer' | 'submitter';
}

/** What this deployment is. `solo` is Foreman; `board` is an innovation-fund board (ADR-016). */
export type Mode = 'solo' | 'board';

export interface SessionState {
  authenticated: true;
  user: SessionUser;
  mode: Mode;
  currency: string;
  totpEnrolled: boolean;
  /** Whether D3 Auth is reachable — not merely configured. A button to a 503 is worse than none. */
  oidcAvailable: boolean;
}

export async function fetchSession(): Promise<SessionState | AnonymousState> {
  try {
    return await api.get<SessionState>('/auth/session');
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      // The body of a 401 is where the login screen learns whether to offer the second path.
      const body = error.body as Partial<AnonymousState> | undefined;
      return {
        authenticated: false,
        oidcAvailable: body?.oidcAvailable ?? false,
        mode: body?.mode ?? 'solo',
      };
    }
    throw error;
  }
}

/** What the 401 carries: no session, but enough to render the right login screen. */
export interface AnonymousState {
  authenticated: false;
  oidcAvailable: boolean;
  mode: Mode;
}

export type LoginResult = { status: 'signed_in' } | { status: 'totp_required' };

export function login(email: string, password: string, totpCode?: string): Promise<LoginResult> {
  return api.post<LoginResult>('/auth/login', {
    email,
    password,
    ...(totpCode !== undefined && totpCode.length > 0 ? { totpCode } : {}),
  });
}

export async function logout(): Promise<void> {
  await api.post<undefined>('/auth/logout');
}

// ─── The read surface the console renders ──────────────────────────────────

export interface PortfolioRow {
  code: string;
  name: string;
  lifecycle: string;
  phase: { humanId: string; number: string; name: string } | null;
  tasks: { open: number; blocked: number; done: number; cancelled: number };
  openCriticals: number;
  /** `unknown` is a third state, and renders grey rather than green (S-04). */
  ci: { conclusion: string | null; unknown: boolean };
  /**
   * CI in three words, served so Home and `foreman_portfolio` answer identically (FRM-T-18.6).
   * Optional on the type only so a fixture that predates it still compiles; the server always sends it.
   */
  ciState?: 'passing' | 'failing' | 'never';
  /** The first thing to pick up in the active phase, or null (FRM-REQ-245). */
  nextTask?: { humanId: string; title: string } | null;
  /** What is running; `ahead` is the commits since it, or null when its SHA is not a known commit. */
  deployed?: { sha: string; at: string; ahead: number | null } | null;
  /** Proposals awaiting review — not drift, so not inside it. */
  unconfirmedAttributions: number;
  /** `counts` is the drift engine's own breakdown and sums to `total`. */
  drift: { counts: Record<DriftItem['category'], number>; total: number };
  lastActivityAt: string | null;
  /** Its group, or null for Ungrouped (FRM-T-17.2). */
  group: ProjectGroupRef | null;
}

/** One section of the grouped portfolio: a group, and its projects' rows in the group's order. */
export interface PortfolioGroup extends ProjectGroupRef {
  siteUrl: string | null;
  projects: PortfolioRow[];
}

/**
 * `GET /api/portfolio` (FRM-REQ-237): `items` flat in code order as it always was, and the same
 * rows again under `groups` in group order, then `ungrouped` — null only when narrowed to a group.
 */
export interface PortfolioResponse {
  items: PortfolioRow[];
  nextCursor: null;
  total: number;
  groups: PortfolioGroup[];
  ungrouped: { humanId: null; name: 'Ungrouped'; slug: 'ungrouped'; projects: PortfolioRow[] } | null;
}

export interface ProjectDetail {
  code: string;
  name: string;
  lifecycle: string;
  pitch: string | null;
  /** The group it is in, or null for Ungrouped (FRM-REQ-223). */
  group: ProjectGroupRef | null;
  counts: { phases: number; requirements: number; tasks: number; openFindings: number };
}

/** A project's group, as `GET /api/projects/:code` names it. */
export interface ProjectGroupRef {
  humanId: string;
  name: string;
  slug: string;
  accent: GroupAccent;
}

/** What a group write takes. Empty strings clear the optional fields. */
export interface GroupInput {
  name: string;
  description: string;
  siteUrl: string;
  accent: GroupAccent;
}

/** A write's answer with the audit events it recorded — what `POST /api/undo/:id` reverses. */
export type Audited<T> = T & { auditEventIds: string[] };

/** What a DELETE (204) gives back: the events it recorded, read from its headers. */
export interface Deleted {
  auditEventIds: string[];
}

/** One status that moved because something beneath it did (ADR-018, `RolledUp` on the server). */
export interface RolledUp {
  humanId: string;
  kind: 'phase' | 'project';
  from: string;
  to: string;
  /** Worked out and deliberately not made — a backfill holding a closed phase. Not a move. */
  held?: true;
}

/** What a task or phase write answers with: the row, what rolled up, and the events for both. */
export interface StatusWrite {
  humanId: string;
  status: string;
  blockedReason?: string | null;
  rolledUp?: RolledUp[];
  auditEventIds: string[];
}

/** `confirm`/`reject` on an attribution (FRM-REQ-105): which commit and task, and the event. */
export interface AttributionWrite {
  commitSha: string;
  taskHumanId: string;
  confirmed: boolean;
  auditEventIds: string[];
}

/** A write that moved or reordered: the listing after it, and the events that undo it. */
export type GroupWrite = GroupListing & { auditEventIds: string[] };

/** The 409 a refused delete answers with: what still holds the group. */
export interface GroupDeleteRefusal {
  error: string;
  projects: string[];
  guidelines: string[];
}

export interface PhaseRow {
  id: string;
  humanId: string;
  number: string;
  sortOrder: number;
  name: string;
  objective: string | null;
  status: string;
  exitDemo: string | null;
  size: string | null;
}

/** A phase with its task counts, from the whole set (FRM-REQ-242). */
export interface PhaseProgressRow extends PhaseRow {
  tasks: { done: number; cancelled: number; total: number };
}

/** `GET /api/findings`: `total` counts the matching set, `counts` it by severity (FRM-REQ-242). */
export interface FindingsPage {
  items: FindingRow[];
  nextCursor: string | null;
  total: number;
  /** The set ignoring the severity filter, so the chips keep their numbers when one is chosen. */
  counts: { critical: number; high: number; medium: number; low: number };
}

export interface TaskRow {
  id: string;
  humanId: string;
  title: string;
  status: string;
  blockedReason: string | null;
  size: string | null;
  doneWhen: string | null;
  body: string | null;
  phaseId: string | null;
  files: string[];
  requirements: string[];
}

export interface RequirementRow {
  id: string;
  humanId: string;
  statement: string;
  priority: string;
  source: string | null;
  acceptanceTest: string | null;
  earsPattern: string;
  earsLintOk: boolean;
  earsLintNote: string | null;
  phase: { humanId: string; name: string } | null;
  /** How many live tasks cite it. Zero is the coverage hole, and the screen says so. */
  coveredBy: number;
  satisfiedBy: { humanId: string; status: string }[];
}

/** What S-13's four filters compile to. Every one of them is applied by the server. */
export interface RequirementFilters {
  priority?: string;
  /** A phase human ID, or `none` for the backlog. */
  phase?: string;
  uncovered?: boolean;
  earsLint?: 'ok' | 'warned';
  limit?: number;
  cursor?: string;
}

export interface Brief {
  project: { code: string; name: string; lifecycle: string; pitch: string | null };
  activePhase: {
    humanId: string;
    number: string;
    name: string;
    objective: string | null;
    exitDemo: string | null;
    tasks: { done: number; cancelled: number; total: number };
  } | null;
  nextTasks: { humanId: string; title: string; status: string; size: string | null }[];
  blocked: { humanId: string; title: string; reason: string | null }[];
  openCriticals: { humanId: string; severity: string; title: string; location: string | null }[];
  ci: { conclusion: string | null; commitSha: string | null; at: string | null; unknown: boolean };
  unconfirmedAttributions: number;
  drift: { counts: Record<DriftItem['category'], number>; total: number };
  recentCommits: { sha: string; message: string; at: string }[];
}

export interface EntityResult {
  type: string;
  humanId: string;
  projectCode: string;
  entity: Record<string, unknown>;
  backlinks: { fromType: string; humanId: string | null; title: string; kind: string }[];
}

export interface Coverage {
  project: string;
  requirements: { total: number; covered: number; musts: number; mustsCovered: number };
  uncoveredMusts: { humanId: string; statement: string; priority: string }[];
  uncovered: { humanId: string; statement: string; priority: string }[];
  withoutAcceptanceTest: { humanId: string; statement: string }[];
  tasksWithoutRequirements: { humanId: string; title: string }[];
  earsWarnings: { humanId: string; statement: string; note: string }[];
}

export interface MatrixRow {
  humanId: string;
  statement: string;
  priority: string;
  earsPattern: string;
  earsLintOk: boolean;
  acceptanceTest: string | null;
  phase: { humanId: string; number: string; name: string } | null;
  satisfiedBy: { humanId: string; title: string; status: string }[];
}

export interface ScopeOfWorkTask {
  humanId: string;
  title: string;
  status: string;
  size: string | null;
  blockedReason: string | null;
  doneWhen: string | null;
  satisfies: string[];
}

export interface ScopeOfWork {
  project: { code: string; name: string };
  phases: {
    humanId: string;
    number: string;
    name: string;
    objective: string | null;
    status: string;
    exitDemo: string | null;
    size: string | null;
    tasks: ScopeOfWorkTask[];
    done: number;
    cancelled: number;
    uncoveredMusts: string[];
  }[];
  unphased: ScopeOfWorkTask[];
  generatedAt: string;
}

export interface GateResult {
  phase: string;
  passed: boolean;
  failures: { kind: string; humanId: string; detail: string }[];
}

export interface DocumentSection {
  id: string;
  key: string;
  heading: string;
  bodyMd: string;
  sortOrder: number;
  updatedAt: string;
}

export interface DocumentDetail {
  id: string;
  kind: string;
  title: string;
  sourcePath: string | null;
  phase: { humanId: string; name: string } | null;
  sections: DocumentSection[];
  updatedAt: string;
}

export interface DocumentRow {
  id: string;
  kind: string;
  title: string;
  phase: { humanId: string; name: string } | null;
  sections: { key: string; heading: string; sortOrder: number }[];
  updatedAt: string;
}

export interface Revision {
  revisionNo: number;
  actor: string;
  actorKind: string;
  note: string | null;
  createdAt: string;
}

export interface DiffResult {
  from: number;
  to: number;
  sections: {
    key: string;
    heading: string;
    status: 'added' | 'removed' | 'changed' | 'unchanged';
    lines: { kind: 'added' | 'removed' | 'same'; text: string }[];
  }[];
}

export interface AdrRow {
  id: string;
  humanId: string;
  number: number;
  title: string;
  status: string;
  decisionAbstract: string | null;
  contextMd: string | null;
  decisionMd: string | null;
  consequencesMd: string | null;
  rejectedMd: string | null;
  decidedOn: string | null;
  relations: { kind: string; relatedAdr: { humanId: string; title: string } }[];
}

export interface AdrGraph {
  nodes: { humanId: string; title: string; status: string }[];
  edges: { from: string; to: string; kind: string }[];
  cycle: string[] | null;
}

export interface RiskRow {
  id: string;
  humanId: string;
  title: string;
  likelihood: string;
  impact: string;
  mitigation: string | null;
  tripwire: string | null;
  status: string;
  firedAt: string | null;
  phase: { humanId: string; name: string } | null;
}

/**
 * An idea — a thing somebody might build, before it is a plan.
 *
 * `project` is present only on the cross-project listing, which is why it is optional here rather
 * than a second type: one row shape, and the column appears when the field does.
 */
export interface IdeaRow {
  id: string;
  humanId: string;
  title: string;
  body: string | null;
  status: 'new' | 'accepted' | 'parked' | 'rejected';
  reason: string | null;
  decidedAt: string | null;
  createdAt: string;
  updatedAt: string;
  project?: { code: string; name: string };
}

/** A project idea. `project` is set only once it has been converted into one. */
/** A standing decision for every project (FRM-REQ-186). */
export interface GuidelineRow {
  id: string;
  humanId: string;
  title: string;
  area: string;
  decision: string;
  rationale: string | null;
  guidance: string | null;
  status: 'active' | 'retired';
  /** Every project, or only the projects in the groups named (FRM-REQ-235). */
  appliesTo: GuidelineScope;
  /** The groups it applies to, in group order — empty when `appliesTo` is `all`. */
  groups: string[];
  createdAt: string;
  updatedAt: string;
}

export type GuidelineScope = 'all' | 'groups';

export interface GuidelineInput {
  title: string;
  area: string;
  decision: string;
  rationale: string;
  guidance: string;
}

/** A guideline's scope as a write gives it: `groups` only with `appliesTo: 'groups'`. */
export type GuidelineScopeInput = { appliesTo: 'all' } | { appliesTo: 'groups'; groups: string[] };

export interface ProjectIdeaRow {
  id: string;
  humanId: string;
  seq: number;
  title: string;
  pitch: string | null;
  status: 'new' | 'considering' | 'shortlisted' | 'funded' | 'parked' | 'rejected' | 'converted';
  fundedAmountCents: number | null;
  /** Null for a submitter: scores are the board's until the decision is made (FRM-REQ-168). */
  score: ScoreSummary | null;
  submittedBy: { id: string; displayName: string } | null;
  _count: { comments: number };
  excitement: number | null;
  tags: string[];
  /** How much of the thinking is written down: the pitch and the five canvas questions. */
  maturity: { filled: number; total: number };
  /** On the list only — the detail page has the questions themselves. */
  openQuestions?: number;
  reason: string | null;
  decidedAt: string | null;
  convertedAt: string | null;
  createdAt: string;
  updatedAt: string;
  project: { code: string; name: string; lifecycle: string } | null;
}

export interface ChecklistItem {
  id: string;
  text: string;
  done: boolean;
}

export interface IdeaLinkRow {
  id: string;
  label: string;
  url: string;
}

/** Everything on an idea's page (FRM-ADR-017). */
export interface ProjectIdeaDetail extends ProjectIdeaRow {
  problem: string | null;
  audience: string | null;
  approach: string | null;
  whyNow: string | null;
  risks: string | null;
  notes: string | null;
  questions: ChecklistItem[];
  nextSteps: ChecklistItem[];
  links: IdeaLinkRow[];
  related: string[];
}

/** A patch to an idea. Any subset; absent means unchanged. */
export type ProjectIdeaPatch = Partial<{
  title: string;
  pitch: string;
  status: string;
  reason: string;
  problem: string;
  audience: string;
  approach: string;
  whyNow: string;
  risks: string;
  notes: string;
  excitement: number | null;
  tags: string[];
  questions: ChecklistItem[];
  nextSteps: ChecklistItem[];
  links: IdeaLinkRow[];
  related: string[];
}>;

export interface MemberRow {
  id: string;
  email: string;
  displayName: string;
  role: 'admin' | 'reviewer' | 'submitter';
  status: 'invited' | 'active' | 'suspended';
  createdAt: string;
  /** Set when the member deleted their account from the app; lifting the suspension cancels it. */
  deleteAfter?: string | null;
  invite: { expiresAt: string; acceptedAt: string | null } | null;
}

export interface ScoreSummary {
  count: number;
  impact: number | null;
  effort: number | null;
  ratio: number | null;
}

export interface ScoreRow {
  id: string;
  impact: number;
  effort: number;
  note: string | null;
  updatedAt: string;
  user: { id: string; displayName: string };
}

export interface CommentRow {
  id: string;
  body: string;
  internal: boolean;
  createdAt: string;
  user: { id: string; displayName: string; role: string };
}

export interface DecisionRow {
  id: string;
  humanId: string;
  statement: string;
  value: string;
  rationale: string | null;
  lockedAt: string | null;
}

export interface TermRow {
  id: string;
  term: string;
  definition: string;
  aliases: string[];
  scope: 'project' | 'ecosystem';
}

export interface SearchHit {
  type: string;
  humanId: string | null;
  projectCode: string | null;
  title: string;
  snippet: string | null;
}

export interface AuditRow {
  id: string;
  humanId: string;
  kind: string;
  scope: string | null;
  runDate: string;
  verdict: string | null;
  rounds: number;
  status: string;
  vaultPath: string | null;
  findings: { total: number; open: number; critical: number; high: number };
}

export interface CommitRow {
  id: string;
  sha: string;
  message: string;
  author: string;
  committedAt: string;
  orphanedAt: string | null;
  repo: { fullName: string };
  files: string[];
  attributions: {
    task: { humanId: string; title: string; status: string };
    source: string;
    confidence: number;
    confirmed: boolean;
    rejectedAt: string | null;
    evidence: unknown;
  }[];
}

export interface CiState {
  conclusion: string | null;
  commitSha: string | null;
  name: string | null;
  at: string | null;
  unknown: boolean;
}

export interface Cadence {
  lastCommitAt: string | null;
  commitsLast7: number;
  commitsLast30: number;
  dormantDays: number | null;
}

export interface DeploymentRow {
  id: string;
  environment: string;
  image: string;
  imageSha: string;
  schemaRevision: string | null;
  deployedAt: string;
  note: string | null;
}

export interface ReleaseRow {
  id: string;
  tag: string;
  name: string | null;
  publishedAt: string | null;
  prerelease: boolean;
}

export interface ReleaseNotes {
  from: string | null;
  to: string;
  tasks: { humanId: string; title: string; status: string }[];
  commits: number;
  unattributed: number;
}

export interface TokenRow {
  id: string;
  name: string;
  /** The short, non-secret prefix — how a token is recognised in a list without revealing it. */
  prefix: string;
  scopes: string[];
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

export interface IssuedToken {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  /** Shown exactly once. No route returns it again, on purpose. */
  token: string;
}

export interface RepoRow {
  id: string;
  fullName: string;
  defaultBranch: string;
  backfilledAt: string | null;
}

export interface FindingRow {
  humanId: string;
  project: string;
  title: string;
  severity: string;
  lenses: string[];
  status: string;
  verified: string;
  effort: string | null;
  foundIn: string | null;
  locations: { path: string; lines: string | null }[];
  fixedCommitSha: string | null;
}

export interface FindingDetail {
  id: string;
  humanId: string;
  title: string;
  severity: string;
  lenses: string[];
  confidence: string | null;
  verified: string;
  status: string;
  effort: string | null;
  foundRound: number | null;
  fixedRound: number | null;
  locationRaw: string | null;
  observedMd: string | null;
  recommendationMd: string | null;
  fixedCommitSha: string | null;
  project: { code: string; name: string };
  audit: { humanId: string; kind: string; runDate: string; verdict: string | null } | null;
  locations: { path: string; lines: string | null; note: string | null }[];
  adr: { humanId: string; title: string } | null;
  requirement: { humanId: string; statement: string } | null;
  phase: { humanId: string; name: string } | null;
  fix: {
    sha: string | null;
    verdict: 'green' | 'red' | 'running' | 'unverified' | 'none';
    detail: string;
    ingested: boolean;
    checks: { name: string; conclusion: string | null }[];
  };
}

export interface RecurrenceResult {
  source: { humanId: string; project: string; title: string };
  candidates: {
    humanId: string;
    project: string;
    title: string;
    severity: string;
    status: string;
    score: number;
    because: { lenses: string[]; words: string[]; pathShapes: string[] };
  }[];
  method: string;
}

export interface RegressionFlag {
  humanId: string;
  project: string;
  title: string;
  path: string;
  changedBy: { sha: string; message: string; at: string }[];
}

export interface DriftItem {
  category:
    | 'coverage-hole'
    | 'stale-task'
    | 'fired-tripwire'
    | 'failed-exit-gate'
    | 'orphan-adr'
    | 'screen-drift';
  humanId: string;
  title: string;
  detail: string;
}

export interface Drift {
  project: string;
  total: number;
  counts: Record<string, number>;
  items: DriftItem[];
}

/** `GET /api/drift`: each project's drift, in Home's order, and the sum (FRM-T-17.4). */
/**
 * `GET /api/search`. `outside` is the exact-ID answer a scope left out, with the group it is in
 * (null for an ungrouped project), so a scoped search can say where it is (FRM-T-17.4).
 */
export interface SearchResult extends Page<SearchHit> {
  outside?: (SearchHit & { group: { humanId: string; name: string; slug: string } | null }) | null;
}

export interface DriftAcross {
  items: (Drift & { name: string })[];
  nextCursor: null;
  total: number;
  drift: { total: number; counts: Record<DriftItem['category'], number> };
}

export interface TechRow {
  name: string;
  category: string;
  version: string | null;
  role: string | null;
  projects: { code: string; version: string | null }[];
}

export interface HealthReport {
  queue: {
    queued: number;
    running: number;
    failed: number;
    oldestQueuedAt: string | null;
    stalled: boolean;
  };
  stageFailures: { jobKind: string; stage: string; error: string; at: string }[];
  lastIngest: string | null;
  lastReconcile: string | null;
  lastBackup: { at: string; path: string; bytes: number } | null;
  lastRestoreDrill: string | null;
  ok: boolean;
  problems: string[];
}

/** One page of a listing — every list route's shape. */
export interface Page<T> {
  items: T[];
  nextCursor: string | null;
  total: number | null;
}

export const foreman = {
  /** Narrowed to a scope — a group's slug or `GRP-n`, or `ungrouped` — when one is given (FRM-T-17.4). */
  portfolio: (group: string | null = null) =>
    api.get<PortfolioResponse>(
      group === null ? '/api/portfolio' : `/api/portfolio?${new URLSearchParams({ group }).toString()}`,
    ),
  project: (code: string) => api.get<ProjectDetail>(`/api/projects/${code}`),
  phases: (code: string) => api.get<Page<PhaseProgressRow>>(`/api/projects/${code}/phases`),
  tasks: (code: string, phaseHumanId?: string) =>
    api.get<Page<TaskRow>>(
      `/api/projects/${code}/tasks?limit=200${phaseHumanId === undefined ? '' : `&phase=${phaseHumanId}`}`,
    ),
  requirements: (code: string, filters: RequirementFilters = {}) => {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(filters)) {
      if (value !== undefined) query.set(key, String(value));
    }
    return api.get<Page<RequirementRow>>(
      `/api/projects/${code}/requirements?${query.toString()}`,
    );
  },
  coverage: (code: string) => api.get<Coverage>(`/api/projects/${code}/coverage`),
  matrix: (code: string) => api.get<Page<MatrixRow>>(`/api/projects/${code}/matrix`),
  scopeOfWork: (code: string) => api.get<ScopeOfWork>(`/api/projects/${code}/scope-of-work`),
  gate: (code: string, phaseHumanId: string) =>
    api.get<GateResult>(`/api/projects/${code}/phases/${phaseHumanId}/gate`),
  documents: (code: string) => api.get<Page<DocumentRow>>(`/api/projects/${code}/documents`),
  /** Read with the version, because this screen writes back to it. */
  document: async (code: string, id: string) => {
    const { body, etag } = await api.getWithEtag(`/api/projects/${code}/documents/${id}`);
    return { body: body as DocumentDetail, etag };
  },
  saveSection: (
    code: string,
    id: string,
    key: string,
    body: { bodyMd: string; heading?: string; note?: string },
    etag: string | null,
  ) =>
    api.put<Audited<DocumentSection>>(
      `/api/projects/${code}/documents/${id}/sections/${key}`,
      body,
      etag,
    ),
  revisions: (code: string, id: string) =>
    api.get<Page<Revision>>(`/api/projects/${code}/documents/${id}/revisions`),
  diff: (code: string, id: string, from: number, to: number) =>
    api.get<DiffResult>(
      `/api/projects/${code}/documents/${id}/diff?from=${String(from)}&to=${String(to)}`,
    ),
  adrs: (code: string) => api.get<Page<AdrRow>>(`/api/projects/${code}/adrs`),
  adrGraph: (code: string) => api.get<AdrGraph>(`/api/projects/${code}/adrs-graph`),
  risks: (code: string) => api.get<Page<RiskRow>>(`/api/projects/${code}/risks`),
  decisions: (code: string) => api.get<Page<DecisionRow>>(`/api/projects/${code}/decisions`),
  glossary: (code: string) => api.get<Page<TermRow>>(`/api/projects/${code}/glossary`),

  // --- Ideas ----------------------------------------------------------------
  ideas: (code: string) => api.get<Page<IdeaRow>>(`/api/projects/${code}/ideas`),
  allIdeas: (status?: string) =>
    api.get<Page<IdeaRow>>(`/api/ideas${status === undefined ? '' : `?status=${status}`}`),
  createIdea: (code: string, body: { title: string; body?: string }) =>
    api.post<Audited<IdeaRow>>(`/api/projects/${code}/ideas`, body),
  updateIdea: (
    code: string,
    humanId: string,
    body: { title?: string; body?: string; status?: string; reason?: string },
  ) => api.patch<Audited<IdeaRow>>(`/api/projects/${code}/ideas/${humanId}`, body),
  deleteIdea: (code: string, humanId: string) =>
    api.del(`/api/projects/${code}/ideas/${humanId}`),

  // --- The innovation board (ADR-016) ---------------------------------------
  members: () => api.get<Page<MemberRow>>('/api/board/members'),
  inviteMember: (body: { email: string; displayName: string; role: string }) =>
    api.post<{ user: MemberRow; acceptUrl: string; expiresAt: string }>(
      '/api/board/members/invite',
      body,
    ),
  updateMember: (id: string, body: { role?: string; suspended?: boolean }) =>
    api.patch<MemberRow>(`/api/board/members/${id}`, body),
  // Scoring and thoughts live on the idea itself, in both modes (FRM-ADR-017).
  scores: (humanId: string) =>
    api.get<{ summary: ScoreSummary; scores: ScoreRow[] }>(`/api/project-ideas/${humanId}/scores`),
  setScore: (humanId: string, body: { impact: number; effort: number; note?: string }) =>
    api.put<ScoreRow>(`/api/project-ideas/${humanId}/scores`, body),
  comments: (humanId: string) =>
    api.get<Page<CommentRow>>(`/api/project-ideas/${humanId}/comments`),
  addComment: (humanId: string, body: { body: string; internal: boolean }) =>
    api.post<CommentRow>(`/api/project-ideas/${humanId}/comments`, body),
  editComment: (humanId: string, id: string, body: string) =>
    api.patch<CommentRow>(`/api/project-ideas/${humanId}/comments/${id}`, { body }),
  deleteComment: (humanId: string, id: string) =>
    api.del(`/api/project-ideas/${humanId}/comments/${id}`),
  fundIdea: (humanId: string, body: { amountCents: number; reason: string }) =>
    api.post<ProjectIdeaRow>(`/api/board/ideas/${humanId}/fund`, body),
  acceptInvite: (body: { token: string; password: string }) =>
    api.post<{ email: string }>('/auth/invite/accept', body),

  // --- Project ideas --------------------------------------------------------
  // No project in any of these paths, because a project idea has none. That is the feature.
  guidelines: () => api.get<Page<GuidelineRow>>('/api/guidelines'),
  createGuideline: (body: GuidelineInput & Partial<GuidelineScopeInput>) =>
    api.post<Audited<GuidelineRow>>('/api/guidelines', body),
  updateGuideline: (
    humanId: string,
    body: Partial<GuidelineInput> & { status?: GuidelineRow['status'] } & Partial<GuidelineScopeInput>,
  ) => api.patch<Audited<GuidelineRow>>(`/api/guidelines/${humanId}`, body),
  deleteGuideline: (humanId: string) => api.del(`/api/guidelines/${humanId}`),
  projectIdeas: (status?: string) =>
    api.get<Page<ProjectIdeaRow>>(
      `/api/project-ideas${status === undefined ? '' : `?status=${status}`}`,
    ),
  createProjectIdea: (body: { title: string; pitch?: string }) =>
    api.post<ProjectIdeaRow>('/api/project-ideas', body),
  projectIdea: (humanId: string) => api.get<ProjectIdeaDetail>(`/api/project-ideas/${humanId}`),
  updateProjectIdea: (humanId: string, body: ProjectIdeaPatch) =>
    api.patch<Audited<ProjectIdeaDetail>>(`/api/project-ideas/${humanId}`, body),
  deleteProjectIdea: (humanId: string) => api.del(`/api/project-ideas/${humanId}`),
  convertProjectIdea: (humanId: string, body: { code: string; name?: string }) =>
    api.post<{
      idea: ProjectIdeaRow;
      project: { code: string; name: string };
      brief: { id: string; title: string } | null;
    }>(
      `/api/project-ideas/${humanId}/convert`,
      body,
    ),
  audits: (code: string) => api.get<Page<AuditRow>>(`/api/projects/${code}/audits`),

  // --- Groups (FRM-ADR-024) -------------------------------------------------
  // `target` is a GRP-n or a slug, or null for the projects in no group — `ungrouped` in the path.
  groups: () => api.get<GroupListing>('/api/groups'),
  group: (idOrSlug: string) => api.get<GroupDetail>(`/api/groups/${encodeURIComponent(idOrSlug)}`),
  createGroup: (body: GroupInput) => api.post<Audited<Group>>('/api/groups', groupBody(body)),
  updateGroup: (humanId: string, body: GroupInput) =>
    api.patch<Audited<Group>>(`/api/groups/${humanId}`, groupBody(body)),
  deleteGroup: (humanId: string) => api.del(`/api/groups/${humanId}`),
  orderGroups: (order: readonly string[]) => api.post<GroupWrite>('/api/groups/order', { order }),
  moveToGroup: (target: string | null, projects: readonly string[]) =>
    api.post<GroupWrite>(`/api/groups/${target ?? 'ungrouped'}/projects`, { projects }),
  orderGroupProjects: (target: string | null, order: readonly string[]) =>
    api.post<GroupWrite>(`/api/groups/${target ?? 'ungrouped'}/projects/order`, { order }),
  /** A project's group, set directly — for a project made somewhere that cannot name one. */
  setProjectGroup: (code: string, group: string | null) =>
    api.patch<unknown>(`/api/projects/${code}`, { group }),
  /** Reverses one audited mutation (409 when the state has moved on since). */
  undo: (auditEventId: string) => api.post<unknown>(`/api/undo/${auditEventId}`),
  /** One record's audit events, newest first, each saying whether it can be undone (FRM-REQ-243). */
  auditEvents: (entity: string, limit = 50) =>
    api.get<AuditEventsResponse>(
      `/api/audit-events?${new URLSearchParams({ entity, limit: String(limit) }).toString()}`,
    ),
  /** The verdict on one event — for those beyond the newest ten, which a history leaves unchecked. */
  auditEventUndoable: (id: string) =>
    api.get<AuditEventUndoability>(`/api/audit-events/${encodeURIComponent(id)}/undoable`),
  /** A task's own fields, by its human ID — status included, with what rolled up (ADR-018). */
  updateTask: (
    code: string,
    humanId: string,
    body: { status?: string; blockedReason?: string },
  ) => api.patch<StatusWrite>(`/api/projects/${code}/tasks/${humanId}`, body),
  search: (q: string, types: string[], project: string | null, group: string | null = null) => {
    const query = new URLSearchParams({ q, limit: '50' });
    if (types.length > 0) query.set('types', types.join(','));
    if (project !== null) query.set('project', project);
    if (group !== null) query.set('group', group);
    return api.get<SearchResult>(`/api/search?${query.toString()}`);
  },
  commits: (code: string, attributed: 'none' | 'proposed' | 'confirmed' | 'any' = 'any') =>
    api.get<Page<CommitRow>>(`/api/projects/${code}/commits?attributed=${attributed}&limit=100`),
  confirmAttribution: (code: string, sha: string, task: string) =>
    api.post<AttributionWrite>(`/api/projects/${code}/attributions/${sha}/confirm`, { task }),
  rejectAttribution: (code: string, sha: string, task: string) =>
    api.post<AttributionWrite>(`/api/projects/${code}/attributions/${sha}/reject`, { task }),
  ci: (code: string) => api.get<CiState>(`/api/projects/${code}/ci`),
  cadence: (code: string) => api.get<Cadence>(`/api/projects/${code}/cadence`),
  deployments: (code: string) => api.get<Page<DeploymentRow>>(`/api/projects/${code}/deployments`),
  releases: (code: string) => api.get<Page<ReleaseRow>>(`/api/projects/${code}/releases`),
  releaseNotes: (code: string, tag: string) =>
    api.get<ReleaseNotes>(`/api/projects/${code}/releases/${encodeURIComponent(tag)}/notes`),
  repos: (code: string) => api.get<Page<RepoRow>>(`/api/projects/${code}/repos`),

  // --- API tokens -----------------------------------------------------------
  // Console-only routes: a token may not mint another token, or a read-only one is a single
  // request away from becoming a write token.
  tokens: () => api.get<Page<TokenRow>>('/api/tokens'),
  issueToken: (body: { name: string; scopes: string[]; expiresInDays?: number }) =>
    api.post<IssuedToken>('/api/tokens', body),
  revokeToken: (id: string) => api.del(`/api/tokens/${id}`),
  /** Where you are signed in: browsers, and D3 Constellation on each device (FRM-T-14.4). */
  sessions: () => api.get<SignedInSession[]>('/auth/sessions'),
  endSession: (id: string) => api.post<undefined>(`/auth/sessions/${encodeURIComponent(id)}/revoke`),
  findings: (
    params: { project?: string; group?: string; severity?: string; status?: string; lens?: string } = {},
  ) => {
    const query = new URLSearchParams({ limit: '200' });
    // `exactOptionalPropertyTypes` means an absent key is absent, not undefined — so the only
    // value worth skipping is the empty string the "any" option sends.
    for (const [key, value] of Object.entries(params)) {
      if (value !== '') query.set(key, value);
    }
    return api.get<FindingsPage>(`/api/findings?${query.toString()}`);
  },
  finding: (humanId: string) => api.get<FindingDetail>(`/api/findings/${humanId}`),
  recurrences: (humanId: string) =>
    api.get<RecurrenceResult>(`/api/findings/${humanId}/recurrences`),
  regressionWatch: () => api.get<Page<RegressionFlag>>('/api/regression-watch'),
  drift: (code: string) => api.get<Drift>(`/api/projects/${code}/drift`),
  /** Drift across projects, by group order, narrowed to a scope when one is given (FRM-T-17.4). */
  driftAcross: (group: string | null = null) =>
    api.get<DriftAcross>(group === null ? '/api/drift' : `/api/drift?${new URLSearchParams({ group }).toString()}`),
  tech: () => api.get<{ items: TechRow[]; disagreements: TechRow[] }>('/api/tech'),
  healthReport: () => api.get<HealthReport>('/api/health-report'),
  brief: (code: string) => api.get<Brief>(`/api/brief/${code}`),
  entity: (humanId: string) => api.get<EntityResult>(`/api/entities/${humanId}`),

  // --- Screens (FRM-REQ-195 … FRM-REQ-197) -----------------------------------
  screens: (code: string) => api.get<Page<Screen>>(`/api/projects/${code}/screens`),
  screen: (code: string, humanId: string) =>
    api.get<ScreenDetail>(`/api/projects/${code}/screens/${humanId}`),
  /** The bytes first; a proposal or capture then names them by SHA. */
  uploadBlob: (file: Blob) => api.upload<UploadedBlob>('/api/blobs', 'file', file),
  addProposal: (code: string, humanId: string, body: ScreenProposalCreate) =>
    api.post<ScreenVersion>(`/api/projects/${code}/screens/${humanId}/proposals`, body),
  recordVerdict: (
    code: string,
    humanId: string,
    versionId: string,
    body: { verdict: ScreenVerdictKind; note?: string },
  ) =>
    api.post<ScreenVerdict>(
      `/api/projects/${code}/screens/${humanId}/captures/${versionId}/verdict`,
      body,
    ),
};

/** Empty optional fields go as null, which clears them, rather than as `''`. */
function groupBody(body: GroupInput) {
  return {
    name: body.name.trim(),
    description: body.description.trim() === '' ? null : body.description.trim(),
    siteUrl: body.siteUrl.trim() === '' ? null : body.siteUrl.trim(),
    accent: body.accent,
  };
}

/** What `POST /api/blobs` answers: the stored file, addressed by its hash. */
export interface UploadedBlob {
  id: string;
  sha256: string;
  mediaType: string;
  byteSize: number;
  url: string;
}

/** One place you are signed in — a browser, or a phone by the name it gave (FRM-T-14.4). */
export interface SignedInSession {
  id: string;
  method: string;
  native: boolean;
  deviceName: string | null;
  devicePlatform: string | null;
  ip: string | null;
  userAgent: string | null;
  createdAt: string;
  lastSeenAt: string;
  current: boolean;
}
