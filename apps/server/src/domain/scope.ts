import type { GroupAccent } from '@foreman/shared';
import type { Db } from '../db.js';
import { NotFound } from './errors.js';
import { findGroup } from './groups.js';

/**
 * A scope — every project, one group, or the ungrouped — as the cross-project reads take it
 * (FRM-ADR-024, FRM-T-17.4).
 *
 * The portfolio, the findings inbox, search and drift across projects all accept the same
 * `?group=`, and they resolve it here, once, so "Dormice" cannot mean one set of projects on Home
 * and another on Findings. A reference is a `GRP-n`, a slug (any case), or `ungrouped`; an empty
 * one is no scope at all. Anything else — an unknown slug, a deleted group, `all` — is a 404,
 * because answering an unknown scope with every project would be a wrong answer delivered
 * confidently: a link to "Dormice's findings" that silently showed everyone's.
 */

export interface ScopeGroup {
  readonly id: string;
  readonly humanId: string;
  readonly name: string;
  readonly slug: string;
  readonly accent: GroupAccent;
}

export type Scope =
  | { readonly kind: 'all' }
  /** `codes` are the group's live projects, in the group's order. */
  | { readonly kind: 'group'; readonly group: ScopeGroup; readonly codes: readonly string[] }
  /** Projects in no live group, in their order among the ungrouped. */
  | { readonly kind: 'ungrouped'; readonly codes: readonly string[] };

const UNGROUPED = 'ungrouped';

const ORDER = [{ groupPosition: 'asc' as const }, { code: 'asc' as const }];

export async function resolveScope(db: Db, ref: string | undefined): Promise<Scope> {
  const narrowed = ref?.trim() ?? '';
  if (narrowed.length === 0) return { kind: 'all' };

  if (narrowed.toLowerCase() === UNGROUPED) {
    const projects = await db.project.findMany({
      // A project whose group is gone counts as ungrouped, as `listGroups` lists it: deleting a
      // group that holds projects is refused, so this is a guard rather than a state.
      where: { deletedAt: null, OR: [{ groupId: null }, { group: { deletedAt: { not: null } } }] },
      orderBy: ORDER,
      select: { code: true },
    });
    return { kind: 'ungrouped', codes: projects.map((p) => p.code) };
  }

  const group = await findGroup(db, narrowed);
  if (group === null) throw new NotFound(`group ${narrowed}`);
  const projects = await db.project.findMany({
    where: { deletedAt: null, groupId: group.id },
    orderBy: ORDER,
    select: { code: true },
  });
  return {
    kind: 'group',
    group: { id: group.id, humanId: group.humanId, name: group.name, slug: group.slug, accent: group.accent },
    codes: projects.map((p) => p.code),
  };
}

/** The project codes a scope admits, or undefined for every project. */
export function scopeCodes(scope: Scope): readonly string[] | undefined {
  return scope.kind === 'all' ? undefined : scope.codes;
}

/**
 * A project-code filter for a read that may also be narrowed to one project: within the scope,
 * and equal to `project` when one is named. A project outside the scope matches nothing, rather
 * than the scope being ignored.
 */
export function codeFilter(
  codes: readonly string[] | undefined,
  project: string | undefined,
): { code?: string | { in: string[] } } {
  if (codes === undefined) return project === undefined ? {} : { code: project };
  return { code: { in: codes.filter((code) => project === undefined || code === project) } };
}
