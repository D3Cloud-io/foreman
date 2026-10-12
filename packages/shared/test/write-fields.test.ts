import { describe, expect, it } from 'vitest';
import {
  CREATE_FIELDS,
  CreatableKind,
  CreateInput,
  SetStatusInput,
  TASK_BODY_MAX,
  TaskCreate,
  TaskUpdate,
  UPDATE_FIELDS,
  UpdateInput,
} from '../src/index.js';

/**
 * A field a kind does not store is refused by name, never dropped (FRM-T-017).
 *
 * On 2026-10-12 twenty FLR task bodies were sent through `foreman_create`, answered as created, and
 * lost: `body` was advertised for every kind and a task had nowhere to keep it.
 */

const paths = (result: { success: boolean; error?: { issues: { path: PropertyKey[] }[] } }) =>
  (result.error?.issues ?? []).map((issue) => issue.path.join('.'));

describe('a task has a body', () => {
  it('takes one on create and update, up to the cap the tools advertise', () => {
    expect(TaskCreate.parse({ title: 't', body: '## Why\n\nBecause.' }).body).toBe('## Why\n\nBecause.');
    expect(TaskUpdate.parse({ body: null }).body).toBeNull();
    expect(TaskUpdate.safeParse({ body: 'x'.repeat(TASK_BODY_MAX + 1) }).success).toBe(false);
  });

  it('is accepted by foreman_create and foreman_update for a task', () => {
    expect(CreateInput.safeParse({ project: 'BND', kind: 'task', text: 't', body: 'b' }).success).toBe(true);
    expect(UpdateInput.safeParse({ id: 'BND-T-0.3', body: 'b' }).success).toBe(true);
  });
});

describe('foreman_create refuses what a kind does not store', () => {
  it('names the field', () => {
    const result = CreateInput.safeParse({ project: 'BND', kind: 'requirement', text: 'r', body: 'b' });
    expect(result.success).toBe(false);
    expect(paths(result)).toEqual(['body']);
  });

  it('refuses a field no kind has', () => {
    const result = CreateInput.safeParse({ project: 'BND', kind: 'task', text: 't', status: 'done' });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain('status');
  });

  it.each([
    ['project', 'doneWhen'],
    ['phase', 'satisfies'],
    ['idea', 'phase'],
    ['requirement', 'size'],
    ['task', 'priority'],
    ['task', 'canvas'],
    ['phase', 'body'],
  ] as const)('a %s with %s', (kind, field) => {
    const value: unknown = field === 'satisfies' ? ['BND-REQ-001'] : field === 'phase' ? 'BND-P-1' : field === 'size' ? 'M' : field === 'priority' ? 'M' : field === 'canvas' ? {} : 'x';
    const result = CreateInput.safeParse({ project: 'BND', kind, text: 't', [field]: value });
    expect(result.success).toBe(false);
    expect(paths(result)).toContain(field);
  });

  it('classifies every field of the schema, so a new one cannot arrive unclassified', () => {
    const classified = new Set(['project', 'kind', 'text', ...Object.values(CREATE_FIELDS).flat()]);
    for (const field of Object.keys(CreateInput.shape)) expect(classified, field).toContain(field);
    expect(Object.keys(CREATE_FIELDS).sort()).toEqual([...CreatableKind.options].sort());
  });
});

describe('foreman_update refuses what a kind does not store', () => {
  it.each([
    ['BND-REQ-001', 'body'],
    ['BND-T-0.3', 'section'],
    ['BND-T-0.3', 'priority'],
    ['BND-T-0.3', 'reason'],
    ['BND-P-1', 'files'],
    ['BND-CR-004', 'size'],
    ['BND-IDEA-002', 'phase'],
    ['PI-007', 'files'],
  ] as const)('%s with %s', (id, field) => {
    const value: unknown =
      field === 'files' ? ['a.ts'] : field === 'size' ? 'M' : field === 'priority' ? 'M' : field === 'section' ? 'risks' : field === 'phase' ? null : 'x';
    const result = UpdateInput.safeParse({ id, [field]: value });
    expect(result.success).toBe(false);
    expect(paths(result)).toContain(field);
  });

  it('classifies every field of the schema', () => {
    const classified = new Set(['id', ...Object.values(UPDATE_FIELDS).flat()]);
    for (const field of Object.keys(UpdateInput.shape)) expect(classified, field).toContain(field);
  });
});

describe('foreman_set_status keeps a reason only where it is stored', () => {
  it('keeps one on a blocked task, an idea and a project idea', () => {
    expect(SetStatusInput.safeParse({ id: 'BND-T-0.3', status: 'blocked', reason: 'r' }).success).toBe(true);
    expect(SetStatusInput.safeParse({ id: 'BND-IDEA-002', status: 'parked', reason: 'r' }).success).toBe(true);
    expect(SetStatusInput.safeParse({ id: 'PI-007', status: 'parked', reason: 'r' }).success).toBe(true);
  });

  it('refuses one anywhere else, and a status on a requirement', () => {
    expect(paths(SetStatusInput.safeParse({ id: 'BND-T-0.3', status: 'done', reason: 'r' }))).toEqual(['reason']);
    expect(paths(SetStatusInput.safeParse({ id: 'BND-CR-004', status: 'wont_fix', reason: 'r' }))).toEqual(['reason']);
    expect(paths(SetStatusInput.safeParse({ id: 'BND-REQ-001', status: 'done' }))).toEqual(['status']);
  });
});
