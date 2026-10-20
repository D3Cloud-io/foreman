import { z } from 'zod';
import { GroupAccent, GuidelineScope, ProjectLifecycle } from '../enums.js';
import { GroupId, ProjectCode } from '../ids.js';

/**
 * Groups — the families one Foreman holds, D3 Cloud and Dormice first (FRM-ADR-024).
 *
 * A group partitions projects: a project is in at most one, and one in none is *Ungrouped* and
 * listed last (FRM-REQ-223). Like a guideline, a group belongs to no project, so its `GRP-001`
 * comes from its own Postgres sequence and is never reused (FRM-REQ-221).
 */

/**
 * Slugs a group name may not take, because a path or a scope already means something by them:
 * `/api/groups/ungrouped/…` addresses the projects in no group, and `?group=all` is the scope
 * that narrows nothing.
 */
export const RESERVED_GROUP_SLUGS: readonly string[] = ['ungrouped', 'all'];

/**
 * The slug a group takes from its name, once, at creation — `D3 Cloud` → `d3-cloud`. It is what a
 * URL carries (`?group=dormice`), so it never changes after, even if the group is renamed.
 */
export function groupSlug(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');
}

/** Absolute and https: a family's site is somewhere a person is sent, so nothing else will do. */
function isHttpsUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname.length > 0;
  } catch {
    return false;
  }
}

const GroupName = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .refine((name) => groupSlug(name).length > 0, {
    message: 'a group name needs at least one letter or digit, which its slug is made from',
  })
  .refine((name) => !RESERVED_GROUP_SLUGS.includes(groupSlug(name)), {
    message: '`Ungrouped` and `All` are reserved: they name the projects in no group, and every group',
  });

/** One line, so it reads beside the group's name rather than under it. `''` clears it. */
const GroupDescription = z
  .string()
  .trim()
  .max(200)
  .refine((text) => !/[\r\n]/.test(text), { message: 'a group description is one line' });

/** An absolute https URL, or `''` / null to clear it. */
const GroupSiteUrl = z.union([
  z.literal(''),
  z.string().trim().max(2000).refine(isHttpsUrl, { message: 'a site URL is an absolute https:// URL' }),
]);

export const GroupCreate = z.object({
  name: GroupName,
  description: GroupDescription.nullable().optional(),
  siteUrl: GroupSiteUrl.nullable().optional(),
  /** One of the design system's product accents. Absent is `neutral`. */
  accent: GroupAccent.optional(),
});
export type GroupCreate = z.infer<typeof GroupCreate>;

/**
 * Everything but the slug, which is not in the shape at all: it is in every link to the group, so
 * a rename keeps it. A position is not here either — order is set by `POST /api/groups/order`,
 * which takes every group at once, so two groups can never claim the same place.
 */
export const GroupUpdate = GroupCreate.partial();
export type GroupUpdate = z.infer<typeof GroupUpdate>;

/** A group as a request names it: `GRP-001`, or its slug. */
export const GroupRef = z.string().trim().min(1).max(80);
export type GroupRef = z.infer<typeof GroupRef>;

/**
 * A group as an MCP argument names it: unbounded, because the route it reaches parses it as a
 * `GroupRef` — and `minLength`/`maxLength` here would be paid on every turn by every session, for
 * a limit the API already enforces and names in its refusal (the tool-definition budget is full).
 */
export const GroupArg = z.string();

function noDuplicates(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

/** The new order of every group, each exactly once (FRM-REQ-226). */
export const GroupOrder = z.object({
  order: z
    .array(GroupId)
    .max(500)
    .refine(noDuplicates, { message: 'each group appears exactly once' }),
});
export type GroupOrder = z.infer<typeof GroupOrder>;

/**
 * Projects moved into a group — out of whichever group held them, since a project is in at most
 * one (FRM-REQ-223). `position` is where they go in the group's order, counted from 0; absent
 * appends them, in the order given.
 */
export const GroupProjectsMove = z.object({
  projects: z
    .array(ProjectCode)
    .min(1)
    .max(500)
    .refine(noDuplicates, { message: 'each project appears exactly once' }),
  position: z.number().int().min(0).optional(),
});
export type GroupProjectsMove = z.infer<typeof GroupProjectsMove>;

/** The new order of every project in one group (or among the ungrouped), each exactly once. */
export const GroupProjectsOrder = z.object({
  order: z
    .array(ProjectCode)
    .max(500)
    .refine(noDuplicates, { message: 'each project appears exactly once' }),
});
export type GroupProjectsOrder = z.infer<typeof GroupProjectsOrder>;

/**
 * A guideline's scope as a write gives it (FRM-REQ-235). `groups` comes only with
 * `appliesTo: 'groups'`, and that needs at least one — a guideline scoped to no group would apply
 * to nothing, which is retiring it under another name.
 */
export const GuidelineScopeFields = {
  appliesTo: GuidelineScope.optional(),
  groups: z
    .array(GroupId)
    .max(100)
    .refine(noDuplicates, { message: 'each group appears exactly once' })
    .optional(),
};

export function checkGuidelineScope(
  value: { appliesTo?: GuidelineScope | undefined; groups?: readonly string[] | undefined },
  ctx: z.RefinementCtx,
): void {
  if (value.appliesTo === 'groups' && (value.groups === undefined || value.groups.length === 0)) {
    ctx.addIssue({
      code: 'custom',
      path: ['groups'],
      message: "a guideline that applies to groups names at least one — or use appliesTo: 'all'",
    });
  }
  if (value.groups !== undefined && value.appliesTo !== 'groups') {
    ctx.addIssue({
      code: 'custom',
      path: ['groups'],
      message: "groups are given only with appliesTo: 'groups'",
    });
  }
}

// ─── Read shapes ───────────────────────────────────────────────────────────

/** A group row as every group endpoint returns it. */
export interface Group {
  readonly id: string;
  readonly humanId: string;
  readonly name: string;
  readonly slug: string;
  readonly description: string | null;
  readonly siteUrl: string | null;
  readonly accent: GroupAccent;
  readonly position: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** A project as a group lists it, in the group's order. */
export interface GroupProject {
  readonly code: string;
  readonly name: string;
  readonly slug: string;
  readonly lifecycle: ProjectLifecycle;
  readonly pitch: string | null;
  /** Its place in the group, or among the ungrouped. Ties are broken by code. */
  readonly position: number;
}

export interface GroupWithProjects extends Group {
  readonly projects: readonly GroupProject[];
  readonly counts: { readonly projects: number; readonly guidelines: number };
}

/** The projects in no group: listed last, and not a group — it has no ID and cannot be renamed. */
export interface UngroupedEntry {
  readonly humanId: null;
  readonly name: 'Ungrouped';
  readonly slug: 'ungrouped';
  readonly projects: readonly GroupProject[];
  readonly counts: { readonly projects: number };
}

/** `GET /api/groups`. */
export interface GroupListing {
  readonly items: readonly GroupWithProjects[];
  readonly ungrouped: UngroupedEntry;
  readonly total: number;
}

/** `GET /api/groups/:idOrSlug`: the group, its projects, and the active guidelines that apply. */
export interface GroupDetail extends GroupWithProjects {
  readonly guidelines: readonly {
    readonly humanId: string;
    readonly title: string;
    readonly decision: string;
    readonly appliesTo: GuidelineScope;
  }[];
}
