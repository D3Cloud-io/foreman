import { describe, expect, it } from 'vitest';
import {
  FORBIDDEN_ESTIMATE_FIELDS,
  PageQuery,
  Phase,
  PhaseCreate,
  PhaseUpdate,
  ProjectCreate,
  ProjectUpdate,
  Task,
  TaskCreate,
  TaskUpdate,
} from '../src/index.js';

describe('project (FRM-REQ-031)', () => {
  it('requires a code on creation', () => {
    expect(ProjectCreate.safeParse({ name: 'Bindery' }).success).toBe(false);
    expect(ProjectCreate.safeParse({ code: 'BND', name: 'Bindery' }).success).toBe(true);
  });

  it('has no code in the update shape at all — immutability as a type, not a rule', () => {
    expect('code' in ProjectUpdate.shape).toBe(false);
    // A code sent to an update is simply not a field, so it cannot be applied by accident.
    const parsed = ProjectUpdate.parse({ name: 'Renamed', code: 'NEW' });
    expect(parsed).not.toHaveProperty('code');
  });

  it('refuses a slug that is not slug-shaped', () => {
    const attempt = ProjectCreate.safeParse({ code: 'BND', name: 'Bindery', slug: 'Not A Slug' });
    expect(attempt.success).toBe(false);
  });
});

describe('phase (FRM-REQ-034, FRM-REQ-035)', () => {
  it('accepts a decimal number, because Phase 8.5 exists', () => {
    const phase = Phase.safeParse({
      id: '00000000-0000-7000-8000-000000000000',
      projectId: '00000000-0000-7000-8000-000000000001',
      humanId: 'BND-P-8.5',
      number: 8.5,
      sortOrder: 10,
      name: 'The half phase',
      objective: null,
      status: 'complete',
      exitDemo: null,
      size: null,
      startedAt: null,
      completedAt: null,
      createdAt: '2026-09-18T00:00:00Z',
      updatedAt: '2026-09-18T00:00:00Z',
      deletedAt: null,
    });
    expect(phase.success).toBe(true);
  });
});

describe('task (FRM-REQ-040)', () => {
  it('refuses a blocked task with no reason', () => {
    const attempt = TaskCreate.safeParse({ title: 'Wire the inbox', status: 'blocked' });
    expect(attempt.success).toBe(false);
    expect(attempt.error?.issues[0]?.path).toEqual(['blockedReason']);
  });

  it('refuses a blocked task whose reason is only whitespace', () => {
    const attempt = TaskCreate.safeParse({
      title: 'Wire the inbox',
      status: 'blocked',
      blockedReason: '   ',
    });
    expect(attempt.success).toBe(false);
  });

  it('accepts a blocked task that says what is blocking it', () => {
    const attempt = TaskCreate.safeParse({
      title: 'Wire the inbox',
      status: 'blocked',
      blockedReason: 'Waiting on the GitHub App installation.',
    });
    expect(attempt.success).toBe(true);
  });

  it('leaves the blocked rule to the domain on an update, where the merged state is known', () => {
    // A patch of `{ status: 'blocked' }` alone is legitimate for a task that already carries a
    // reason. Refusing it in the schema would reject a correct request, so the check happens where
    // the task's existing reason is visible.
    expect(TaskUpdate.safeParse({ status: 'blocked' }).success).toBe(true);
    expect(TaskUpdate.safeParse({ status: 'todo' }).success).toBe(true);
  });

  it('lets a task satisfy several requirements', () => {
    const parsed = TaskCreate.parse({
      title: 'Covers three',
      requirementIds: [
        '00000000-0000-7000-8000-000000000001',
        '00000000-0000-7000-8000-000000000002',
        '00000000-0000-7000-8000-000000000003',
      ],
    });
    expect(parsed.requirementIds).toHaveLength(3);
  });
});

describe('no time estimates anywhere (FRM-REQ-041)', () => {
  // The guard is worth more on the schemas than on the database, because this is where a field
  // would be added first.
  const shapes = { Task: Task.shape, Phase: Phase.shape };

  it.each(Object.entries(shapes))('%s declares no estimate-shaped field', (_name, shape) => {
    const offending = Object.keys(shape).filter((key) =>
      FORBIDDEN_ESTIMATE_FIELDS.some((banned) => key.toLowerCase() === banned.toLowerCase()),
    );
    expect(offending).toEqual([]);
  });
});

describe('paging (FRM-REQ-092)', () => {
  it('defaults to a bounded page', () => {
    expect(PageQuery.parse({}).limit).toBe(50);
  });

  it('refuses an unbounded request', () => {
    expect(PageQuery.safeParse({ limit: 100_000 }).success).toBe(false);
    expect(PageQuery.safeParse({ limit: 0 }).success).toBe(false);
  });
});

describe('phase number (FRM-T-027)', () => {
  // The column is numeric(6,2): under 10000 either side of zero, two decimal places at most.
  it('accepts what the column holds', () => {
    for (const number of [0, 1, 8.5, 8.55, 9999.99, -9999.99]) {
      expect(PhaseCreate.safeParse({ number, name: 'P' }).success, String(number)).toBe(true);
    }
  });

  it('refuses what it would overflow or round, naming the field', () => {
    for (const number of [10000, 123456, -10000, 1.234, Number.NaN]) {
      const parsed = PhaseCreate.safeParse({ number, name: 'P' });
      expect(parsed.success, String(number)).toBe(false);
      expect(parsed.error?.issues[0]?.path).toEqual(['number']);
    }
    expect(PhaseUpdate.safeParse({ number: 123456 }).success).toBe(false);
    expect(PhaseUpdate.safeParse({}).success).toBe(true);
  });
});
