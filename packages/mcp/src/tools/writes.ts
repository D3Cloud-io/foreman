import {
  AttributeInput,
  CreateInput,
  DeleteInput,
  gateForAttribute,
  gateForDelete,
  gateForLink,
  gateForPriority,
  gateForStatus,
  LinkInput,
  IDEA_LIST_KEYS,
  listItemId,
  parseAnyId,
  parseHumanId,
  parseIdeaList,
  PROJECT_ID_TYPE,
  type IdeaListKey,
  SetStatusInput,
  UpdateInput,
  updateTargetType,
  type GateDecision,
} from '@foreman/shared';
import type { ForemanClient } from '../client.js';

/**
 * The write tools (T-2.8), and the gate in front of them (T-2.9).
 *
 * **Forward progress is never gated.** Marking a task done, filing a finding, logging a decision —
 * these are the motions of working, and a confirmation on each is exactly how a confirmation stops
 * being read. What is gated is the small set of changes that lose something: a delete, a regression,
 * an abandonment, a `Won't`, an unlink.
 *
 * The gate rules themselves live in `packages/shared` because "which changes need asking about" is
 * a property of the change and not of the surface making it.
 */

export interface WriteToolDefinition {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly inputSchema:
    | typeof CreateInput
    | typeof UpdateInput
    | typeof SetStatusInput
    | typeof LinkInput
    | typeof DeleteInput
    | typeof AttributeInput;
  /** Whether this call needs asking about first, decided from the arguments and current state. */
  gate(client: ForemanClient, input: unknown): Promise<GateDecision>;
  run(client: ForemanClient, input: unknown): Promise<unknown>;
}

/** The current status of an entity, so a status change can be judged as forward or backward. */
async function currentStatus(
  client: ForemanClient,
  humanId: string,
): Promise<{ type: string; status: string | null; priority: string | null }> {
  const result = await client.get<{
    type: string;
    entity: { status?: string; priority?: string };
  }>(`/api/entities/${humanId}`, { backlinks: false });
  return {
    type: result.type,
    status: result.entity.status ?? null,
    priority: result.entity.priority ?? null,
  };
}

function projectOf(humanId: string): string {
  const parsed = parseHumanId(humanId);
  if (parsed === null) throw new Error(`${humanId} is not a project-prefixed human ID`);
  return parsed.code;
}

export const WRITE_TOOLS: readonly WriteToolDefinition[] = [
  {
    name: 'foreman_create',
    title: 'Create',
    description:
      'Add a project, a project idea, a group, or a requirement, task, phase, idea or screen inside ' +
      'a project.',
    inputSchema: CreateInput,
    // Creating loses nothing, so it is never gated.
    gate: () => Promise.resolve({ gated: false }),
    run: async (client, input) => {
      const args = CreateInput.parse(input);
      const body: Record<string, unknown> = {};

      switch (args.kind) {
        case 'project_idea':
          // The one kind with no project in its path, because it has no project — it is a
          // candidate for one. Converting it is deliberately console-only: that is where a code
          // is chosen, and a code is immutable (ADR-008).
          return client.post('/api/project-ideas', {
            title: args.text,
            ...(args.pitch === undefined ? {} : { pitch: args.pitch }),
            ...canvasBody(args.canvas),
          });
        case 'project':
          // Not created *inside* a project, so it posts to a different path: `project` is the
          // code to give it rather than the code to file it under. `group` puts it at the end of
          // that group's order (FRM-REQ-238).
          return client.post('/api/projects', {
            code: args.project ?? '',
            name: args.text,
            ...(args.pitch === undefined ? {} : { pitch: args.pitch }),
            ...(args.group === undefined ? {} : { group: args.group }),
          });
        case 'group':
          // A family of projects (FRM-ADR-024): no project of its own, so no project path. It
          // joins the end of the group order; reordering is the console's.
          return client.post('/api/groups', {
            name: args.text,
            ...(args.pitch === undefined ? {} : { description: args.pitch }),
            ...(args.siteUrl === undefined ? {} : { siteUrl: args.siteUrl }),
            ...(args.accent === undefined ? {} : { accent: args.accent }),
          });
        case 'idea':
          body['title'] = args.text;
          if (args.body !== undefined) body['body'] = args.body;
          break;
        case 'requirement':
          body['statement'] = args.text;
          if (args.priority !== undefined) body['priority'] = args.priority;
          break;
        case 'task':
          body['title'] = args.text;
          if (args.body !== undefined) body['body'] = args.body;
          if (args.doneWhen !== undefined) body['doneWhen'] = args.doneWhen;
          if (args.size !== undefined) body['size'] = args.size;
          break;
        case 'phase':
          body['name'] = args.text;
          body['number'] = args.number ?? 0;
          if (args.size !== undefined) body['size'] = args.size;
          break;
        case 'screen':
          // A name and a route (FRM-REQ-189); proposals and captures arrive through the API.
          body['name'] = args.text;
          if (args.route !== undefined) body['route'] = args.route;
          break;
      }
      // Anything a kind does not store was refused by `CreateInput` (CREATE_FIELDS) before this
      // ran, so every field that reached here is one the switch above sends.

      // Every remaining kind required a project code, enforced by `CreateInput` itself.
      return client.post(`/api/projects/${args.project ?? ''}/${args.kind}s`, body, {
        // A phase is addressed by its human ID; the server resolves it.
        ...(args.phase === undefined ? {} : { phase: args.phase }),
        ...(args.satisfies === undefined ? {} : { satisfies: args.satisfies }),
      });
    },
  },
  {
    name: 'foreman_update',
    title: 'Update',
    description:
      'Change an entity’s text, body, priority, size, phase, a task’s declared files or a ' +
      'project’s group. A field its kind does not store is refused.',
    inputSchema: UpdateInput,
    gate: (_client, input) => {
      const args = UpdateInput.parse(input);
      // Nothing to look up: the only gated field here is decided by the request itself.
      return Promise.resolve(args.priority === undefined ? { gated: false } : gateForPriority(args.priority));
    },
    run: async (client, input) => {
      const args = UpdateInput.parse(input);
      const kind = kindOf(args.id);
      const body: Record<string, unknown> = {};
      if (kind === 'projects') {
        // A project by its bare code: its name, its pitch, and its group — a move to the end of
        // that group's order, or with null out of every group (FRM-REQ-238). Everything else was
        // refused by `UpdateInput` (UPDATE_FIELDS).
        if (args.text !== undefined) body['name'] = args.text;
        if (args.body !== undefined) body['pitch'] = args.body;
        if (args.group !== undefined) body['group'] = args.group;
        return client.patch(`/api/projects/${args.id}`, body);
      }
      if (kind === 'project-ideas') {
        // `text` is the title unless a canvas field is named, in which case it is that field — a
        // section's Markdown, or a list written one item per line. `body` is the pitch. No project
        // path, because a project idea has no project.
        if (args.text !== undefined) {
          const field = args.section ?? 'title';
          body[field] = isListKey(field) ? parseIdeaList(field, args.text) : args.text;
        }
        if (args.body !== undefined) body['pitch'] = args.body;
        if (args.reason !== undefined) body['reason'] = args.reason;
        return client.patch(`/api/project-ideas/${args.id}`, body);
      }
      // What `text` is called on each kind. A phase's is `name`: sending it as `title` was
      // stripped by the API, so renaming a phase reported success and changed nothing.
      if (args.text !== undefined) {
        body[kind === 'requirements' ? 'statement' : kind === 'phases' ? 'name' : 'title'] = args.text;
      }
      if (args.priority !== undefined) body['priority'] = args.priority;
      if (args.size !== undefined) body['size'] = args.size;
      if (args.doneWhen !== undefined) body['doneWhen'] = args.doneWhen;
      if (args.body !== undefined) body['body'] = args.body;
      if (args.reason !== undefined) body['reason'] = args.reason;
      if (args.fixedCommitSha !== undefined) body['fixedCommitSha'] = args.fixedCommitSha;

      // Only a task declares files — the wave-planning `/fleet-develop` reads (FRM-T-007). Refused
      // by name for every other kind, the same shape as `phase` is refused above.
      if (args.files !== undefined) {
        if (kind !== 'tasks') {
          throw new Error(`${args.id} has no files to declare; only a task does`);
        }
        body['files'] = args.files;
      }

      // Advertised from the start and never sent until 2026-09-24: a move reported success and
      // left the task where it was. Only a task or a requirement has a phase, so anything else is
      // refused by name rather than silently ignored. The backlog needs no lookup; a phase is sent
      // as its human ID and resolved by the server, as `foreman_create` does.
      const query: Record<string, string> = {};
      if (args.phase !== undefined) {
        if (kind !== 'tasks' && kind !== 'requirements') {
          throw new Error(`${args.id} has no phase to move; only a task or a requirement does`);
        }
        if (args.phase === null) body['phaseId'] = null;
        else query['phase'] = args.phase;
      }
      const path = `/api/projects/${projectOf(args.id)}/${kind}/${args.id}`;
      return 'phase' in query ? client.patch(path, body, query) : client.patch(path, body);
    },
  },
  {
    name: 'foreman_set_status',
    title: 'Set status',
    description:
      'Move a task, phase or finding to a new status. Blocked needs a reason; regressing, ' +
      'cancelling and completing a phase are confirmed first.',
    inputSchema: SetStatusInput,
    gate: async (client, input) => {
      const args = SetStatusInput.parse(input);
      const current = await currentStatus(client, args.id);
      return gateForStatus(current.type, current.status, args.status);
    },
    run: async (client, input) => {
      const args = SetStatusInput.parse(input);
      if (kindOf(args.id) === 'project-ideas') {
        return client.patch(`/api/project-ideas/${args.id}`, {
          status: args.status,
          ...(args.reason === undefined ? {} : { reason: args.reason }),
        });
      }
      return client.patch(`/api/projects/${projectOf(args.id)}/${kindOf(args.id)}/${args.id}`, {
        status: args.status,
        // Where the reason goes depends on what is being moved. A task carries it as
        // `blockedReason` and only while blocked — sending it whatever the status was put a note
        // explaining why something was *finished* into `blockedReason` on a done task, which
        // reads to anyone who finds it later as a record of that task being stuck.
        //
        // An idea carries a plain `reason`, and parking or rejecting one *requires* it: the whole
        // value of writing a rejection down is that it is not re-argued by somebody who cannot
        // tell it was already considered.
        ...reasonFor(args.id, args.status, args.reason),
      });
    },
  },
  {
    name: 'foreman_delete',
    title: 'Delete an idea',
    description:
      'Delete an idea or project idea. Anything else is cited by something, so is deleted from the ' +
      'console. Soft, undoable, confirmed first.',
    inputSchema: DeleteInput,
    // Always gated, even though an idea is the cheapest thing here to lose. A gate that applies
    // only to expensive deletions teaches that an ungated one is safe, and this is the verb whose
    // scope is most likely to widen later.
    gate: () => Promise.resolve(gateForDelete()),
    run: async (client, input) => {
      const args = DeleteInput.parse(input);
      await client.del(
        kindOf(args.id) === 'project-ideas'
          ? `/api/project-ideas/${args.id}`
          : `/api/projects/${projectOf(args.id)}/${kindOf(args.id)}/${args.id}`,
      );
      return { deleted: args.id };
    },
  },
  {
    name: 'foreman_link',
    title: 'Link',
    description:
      'Cite one entity from another: a task satisfies a requirement, a finding violates one, an ' +
      'ADR supersedes another, a task depends_on one it cannot start before. Unlinking is ' +
      'confirmed first.',
    inputSchema: LinkInput,
    gate: (_client, input) => Promise.resolve(gateForLink(LinkInput.parse(input).remove)),
    run: async (client, input) => {
      const args = LinkInput.parse(input);
      return client.post('/api/links', args);
    },
  },
  {
    name: 'foreman_attribute',
    title: 'Attribute a commit',
    description:
      'Declare which task a commit was work on. Recorded as confirmed, unlike the guesses from its ' +
      'message or files.',
    inputSchema: AttributeInput,
    gate: (_client, input) => Promise.resolve(gateForAttribute(AttributeInput.parse(input).remove)),
    run: async (client, input) => {
      const args = AttributeInput.parse(input);
      const project = projectOf(args.task);
      const action = args.remove ? 'reject' : 'confirm';
      return client.post(
        `/api/projects/${project}/attributions/${args.sha}/${action}`,
        { task: args.task, ...(args.remove ? {} : { declared: true }) },
      );
    },
  },
];

/**
 * Where a status change's reason belongs, by what is being moved.
 *
 * Two entities take one, under different names and different rules, and getting it wrong is
 * silent: the note lands on a field nothing reads, or on a field that then misreports the row.
 */
function reasonFor(
  humanId: string,
  status: string,
  reason: string | undefined,
): Record<string, string> {
  if (reason === undefined) return {};
  if (parseAnyId(humanId)?.type === 'IDEA') return { reason };
  return status === 'blocked' ? { blockedReason: reason } : {};
}

const isListKey = (key: string): key is IdeaListKey =>
  (IDEA_LIST_KEYS as readonly string[]).includes(key);

/**
 * A `canvas` argument into the API's shape. The shim's side of the contract is plain items, the
 * API's is `{ id, text, done }` and `{ id, label, url }` — so the ids are made here, deterministically,
 * and a model never has to invent one.
 */
function canvasBody(canvas: CreateInput['canvas']): Record<string, unknown> {
  if (canvas === undefined) return {};
  const { questions, nextSteps, links, ...rest } = canvas;
  const checklist = (items: string[] | undefined) =>
    items?.map((text, i) => ({ id: listItemId(i, text), text, done: false }));
  return {
    ...rest,
    ...(questions === undefined ? {} : { questions: checklist(questions) }),
    ...(nextSteps === undefined ? {} : { nextSteps: checklist(nextSteps) }),
    ...(links === undefined
      ? {}
      : { links: links.map((l, i) => ({ id: listItemId(i, l.url), label: l.label, url: l.url })) }),
  };
}

/** The path segment for an entity's kind, from its human ID — or a project's bare code. */
function kindOf(humanId: string): string {
  switch (updateTargetType(humanId)) {
    // A project is addressed by its code, which is not a human ID; only `foreman_update` takes one,
    // and `/api/projects/:code` is its path whole.
    case PROJECT_ID_TYPE:
      return 'projects';
    case 'REQ':
      return 'requirements';
    case 'T':
      return 'tasks';
    case 'P':
      return 'phases';
    // Every audit lens writes its findings under its own prefix, and they are all one table.
    // Leaving them out meant `foreman_set_status` threw on the ID its own description invites —
    // so a session that fixed a finding could read it and never close it, and the findings inbox
    // stayed full of work that was already done.
    case 'CR':
    case 'DA':
    case 'FR':
    case 'API':
      return 'findings';
    case 'IDEA':
      return 'ideas';
    // Not under `/api/projects/…` at all. Callers check for this segment rather than building
    // the usual path, which is why it is spelled the way the route is.
    case 'PI':
      return 'project-ideas';
    default:
      throw new Error(`${humanId} cannot be changed through this tool`);
  }
}
