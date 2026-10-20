import { z } from 'zod';
import { BuildState, type CheckConclusion } from '../enums.js';
import { Instant } from './common.js';

/**
 * A build result reported by an authorized deployer — Shipyard — as a commit's CI state
 * (FRM-T-008, FRM-REQ-182).
 *
 * The body is Shipyard's own `foreman_build` outbox row (SHP-REQ-147), so its drain can post the
 * row as it stands: `kind` and `project` are what the row already carries, and both are checked
 * rather than ignored. The optional fields beyond it are what a check run has room for and the row
 * does not yet send.
 *
 * It lands as a **check run**, not a new record: the brief's `ci` and the activity screen already
 * read the latest completed check run, and a build that fed a second table would need both to
 * learn where CI comes from. A build is told apart from a GitHub check by its name
 * (`shipyard/build/<app>`). Which builds have been heard of is kept apart from it, one row per
 * `buildId`, because the check run changes and that record must not: it is what makes a replay
 * change nothing, even of a build a later one has since superseded.
 */

/**
 * What each state is as a check conclusion. `refused` — a fail-closed gate declined to build the
 * commit at all — is `action_required`: nothing ran, so it is not a `failure` of the code, and it is
 * not green either; somebody has to act before this commit can build.
 */
export const BUILD_CONCLUSION: Readonly<Record<BuildState, CheckConclusion>> = {
  succeeded: 'success',
  failed: 'failure',
  cancelled: 'cancelled',
  refused: 'action_required',
};

/** Every check run a build writes is named under this prefix; nothing GitHub sends is. */
export const BUILD_CHECK_PREFIX = 'shipyard/build/';

/** The check run name for an app's builds: one per app per commit, so a rebuild replaces it. */
export function buildCheckName(app: string): string {
  return `${BUILD_CHECK_PREFIX}${app}`;
}

export const BuildResultInput = z.object({
  /** The outbox row's discriminator. Accepted so the row can be posted verbatim. */
  kind: z.literal('foreman_build').optional(),
  /** Shipyard's build ID. The idempotency key: the same ID twice is one build, recorded once. */
  buildId: z.string().min(1).max(200),
  /** Shipyard's app name. Names the check run, so two apps built from one commit stay two checks. */
  app: z
    .string()
    .regex(/^[\w.-]{1,100}$/, 'an app name is letters, digits, dot, dash and underscore'),
  /** The full commit SHA that was built. Shipyard only ever builds a 40-hex SHA. */
  sha: z
    .string()
    .regex(/^[0-9a-fA-F]{40}$/, 'a commit SHA is 40 hex characters')
    .transform((sha) => sha.toLowerCase()),
  /** The project code. Optional — the URL names it — and refused if it names another project. */
  project: z.string().min(1).max(20).optional(),
  /** The environment the app deploys to. A build has none of its own; kept on the build's record. */
  environment: z.string().min(1).max(60).optional(),
  state: BuildState,
  /** The stage that failed, when one did. Kept on the build's record beside the conclusion. */
  failedStage: z.string().min(1).max(100).optional(),
  /**
   * `owner/name`. Needed only when the project links more than one repository and the commit has
   * not been ingested yet; otherwise the repository is the one that holds the commit, or the
   * project's only one.
   */
  repo: z
    .string()
    .regex(/^[\w.-]+\/[\w.-]+$/, 'a repository is owner/name')
    .optional(),
  startedAt: Instant.optional(),
  /**
   * When the build finished. Defaults to when Foreman received it. Of two results for one commit
   * and app, the one that finished later is what the check run shows, whatever order they arrive in.
   */
  completedAt: Instant.optional(),
  /** The build's page in Shipyard, stored as the check run's details link. */
  url: z.url().max(2000).optional(),
});
export type BuildResultInput = z.infer<typeof BuildResultInput>;
