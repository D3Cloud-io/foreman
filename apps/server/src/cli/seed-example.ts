import { randomBytes } from 'node:crypto';
import { parseLocation } from '@foreman/shared';
import { setPassword } from '../auth/native.js';
import { loadConfig } from '../config.js';
import { createDb, type Db } from '../db.js';
import { record } from '../domain/audit.js';
import { settleInserted } from '../domain/groups.js';

/**
 * The disposable example project (FRM-REQ-014).
 *
 * Development runs against this, never against the real corpus — that is imported once, in Phase
 * 10, and not before. So this has to exercise **every entity and every enum value**: a seed that
 * only covers the happy path is how a `parked` phase or a `wont_fix` finding reaches production
 * having never once been rendered.
 *
 *   pnpm seed:example
 *
 * Re-runnable: it deletes the example project first, and leaves every other project alone.
 */

const CODE = 'EXMP';
/** The second project. Recurrence is cross-project, so one project cannot show it. */
const OTHER_CODE = 'NBR';

async function seed(db: Db, config: ReturnType<typeof loadConfig>): Promise<void> {
  // `deleteMany`, not find-then-delete: the pair is not atomic, and two seeds run close together
  // race into "the record required but not found". Cascades take the phases, tasks, requirements,
  // documents and findings with it. Other projects are untouched.
  const { count } = await db.project.deleteMany({ where: { code: { in: [CODE, OTHER_CODE] } } });
  if (count > 0) process.stdout.write(`removed the previous ${CODE} project\n`);

  // The seeded example job is addressed by kind, so re-seeding does not pile them up.
  await db.job.deleteMany({ where: { kind: 'example', payload: { path: ['note'], equals: 'seeded' } } });

  const project = await db.project.create({
    data: {
      code: CODE,
      name: 'Example Project',
      slug: 'example-project',
      lifecycle: 'building',
      pitch: 'The disposable project development runs against. Never the real corpus.',
      vaultPath: 'D3 Cloud Vault/Example Project',
    },
  });

  // Phases: a decimal number, a sort order that disagrees with it, and every status. This is the
  // shape the real corpus has — Bindery built 0–8.5, then 9–11, then 13–16, with 12 still ahead.
  const phases = await Promise.all(
    [
      { number: 0, sortOrder: 0, name: 'Foundation', status: 'complete' as const, size: 'M' as const },
      { number: 1, sortOrder: 1, name: 'Where Are We', status: 'active' as const, size: 'L' as const },
      { number: 8.5, sortOrder: 2, name: 'The Half Phase', status: 'complete' as const, size: 'S' as const },
      { number: 9, sortOrder: 3, name: 'Hardening', status: 'planned' as const, size: 'XL' as const },
      { number: 12, sortOrder: 9, name: 'Later Features', status: 'parked' as const, size: 'XS' as const },
    ].map((phase) =>
      db.phase.create({
        data: {
          projectId: project.id,
          humanId: `${CODE}-P-${String(phase.number)}`,
          number: phase.number,
          sortOrder: phase.sortOrder,
          name: phase.name,
          status: phase.status,
          size: phase.size,
          objective: `Everything ${phase.name.toLowerCase()} needs, and nothing it does not.`,
          exitDemo: `Show ${phase.name.toLowerCase()} working end to end.`,
        },
      }),
    ),
  );

  const [p0, p1, p85, p9] = phases;
  if (p0 === undefined || p1 === undefined || p85 === undefined || p9 === undefined) {
    throw new Error('phases were not created');
  }

  await db.phaseDependency.create({
    data: { phaseId: p1.id, dependsOnId: p0.id, reason: 'Phase 1 assumes the schema exists.' },
  });

  // Requirements: every EARS pattern, every MoSCoW priority, and one with no phase — the backlog,
  // which is legal and meaningful.
  const patterns = [
    'ubiquitous',
    'state',
    'event',
    'unwanted',
    'optional',
    'complex',
    'unparsed',
  ] as const;
  const priorities = ['M', 'S', 'C', 'W'] as const;

  const requirements = await Promise.all(
    patterns.map((pattern, index) =>
      db.requirement.create({
        data: {
          projectId: project.id,
          humanId: `${CODE}-REQ-${String(index + 1).padStart(3, '0')}`,
          seq: index + 1,
          statement:
            pattern === 'unparsed'
              ? 'This sentence is not in EARS notation at all, and is kept anyway.'
              : `While the system is running, the system shall satisfy the ${pattern} case.`,
          earsPattern: pattern,
          earsLintOk: pattern !== 'unparsed',
          ...(pattern === 'unparsed' ? { earsLintNote: 'no EARS keyword found' } : {}),
          priority: priorities[index % priorities.length] ?? 'M',
          source: 'Discovery',
          acceptanceTest: `A test covers the ${pattern} case.`,
          // The last one is left unassigned on purpose: that is the backlog.
          phaseId: index < patterns.length - 1 ? (phases[index % 4]?.id ?? null) : null,
        },
      }),
    ),
  );

  // Tasks: every status, one blocked with a reason, one with a synthesized ID.
  const taskSpecs = [
    { seq: '0.1', title: 'Scaffold the monorepo', status: 'done' as const, phase: p0 },
    { seq: '0.2', title: 'Write the schema', status: 'done' as const, phase: p0 },
    { seq: '1.1', title: 'Build the portfolio screen', status: 'in_progress' as const, phase: p1 },
    {
      seq: '1.2',
      title: 'Wire the findings inbox',
      status: 'blocked' as const,
      phase: p1,
      blockedReason: 'Waiting on the GitHub App installation.',
    },
    { seq: '8.5', title: 'The half-phase task', status: 'todo' as const, phase: p85, synthesized: true },
    { seq: '9.1', title: 'An idea that did not survive', status: 'cancelled' as const, phase: p9 },
  ];

  const tasks = await Promise.all(
    taskSpecs.map((spec, index) =>
      db.task.create({
        data: {
          projectId: project.id,
          phaseId: spec.phase.id,
          humanId: `${CODE}-T-${spec.seq}`,
          title: spec.title,
          status: spec.status,
          ...(spec.blockedReason !== undefined ? { blockedReason: spec.blockedReason } : {}),
          ...(spec.synthesized === true ? { idSynthesized: true } : {}),
          size: (['XS', 'S', 'M', 'L', 'XL'] as const)[index % 5] ?? 'M',
          doneWhen: `${spec.title} is demonstrably working.`,
          // Every other task carries a body, so both shapes — with context and without — show.
          ...(index % 2 === 0
            ? { body: `Why **${spec.title.toLowerCase()}** matters, in the owner's words.` }
            : {}),
          sortOrder: index,
          files: { create: [{ path: `apps/server/src/${spec.seq.replace('.', '-')}.ts` }] },
          requirements: {
            create: [{ requirementId: requirements[index % requirements.length]?.id ?? '' }],
          },
        },
      }),
    ),
  );

  // ADRs: every status, and a supersedes edge.
  const adrs = await Promise.all(
    (['accepted', 'proposed', 'rejected', 'superseded'] as const).map((status, index) =>
      db.adr.create({
        data: {
          projectId: project.id,
          humanId: `${CODE}-ADR-${String(index + 1).padStart(3, '0')}`,
          number: index + 1,
          title: `A decision that is ${status}`,
          status,
          decisionAbstract: `The ${status} option was taken, for the reasons below.`,
          contextMd: 'What made a decision necessary.',
          decisionMd: 'What was decided.',
          consequencesMd: '**Good.** What improves.\n\n**Bad.** What it costs.',
          decidedOn: new Date('2026-09-01'),
        },
      }),
    ),
  );
  const [adrAccepted, , , adrSuperseded] = adrs;
  if (adrAccepted !== undefined && adrSuperseded !== undefined) {
    await db.adrRelation.createMany({
      data: [
        { adrId: adrAccepted.id, relatedAdrId: adrSuperseded.id, kind: 'supersedes' },
        { adrId: adrSuperseded.id, relatedAdrId: adrAccepted.id, kind: 'superseded_by' },
      ],
    });
  }

  await db.decision.create({
    data: {
      projectId: project.id,
      humanId: `${CODE}-D-01`,
      statement: 'Which database?',
      value: 'PostgreSQL 16',
      rationale: 'The ecosystem default, and every other service already runs it.',
      lockedAt: new Date('2026-09-01'),
    },
  });

  // Risks: every status and level, and one with a tripwire that has fired.
  await db.risk.createMany({
    data: [
      {
        projectId: project.id,
        phaseId: p1.id,
        humanId: `${CODE}-R-01`,
        title: 'The cross-repo dependency blocks the main screens',
        likelihood: 'medium',
        impact: 'high',
        mitigation: 'Build the shared component first, in Phase 0.',
        tripwire: 'The component is not released by the end of Phase 0.',
        status: 'open',
      },
      {
        projectId: project.id,
        humanId: `${CODE}-R-02`,
        title: 'An attribution is trusted without confirmation',
        likelihood: 'low',
        impact: 'high',
        mitigation: 'No calculation reads an unconfirmed row.',
        tripwire: 'A coverage figure changes without a confirmation.',
        status: 'fired',
        firedAt: new Date('2026-09-10'),
      },
      {
        projectId: project.id,
        humanId: `${CODE}-R-03`,
        title: 'A risk that turned out not to be one',
        likelihood: 'low',
        impact: 'low',
        mitigation: 'None needed.',
        status: 'closed',
      },
    ],
  });

  // Ideas: one of every status, so the screen's four counters and its bar all have something
  // to show, and so the axe sweep sees a populated page rather than an empty state.
  await db.idea.createMany({
    data: [
      {
        projectId: project.id,
        humanId: `${CODE}-IDEA-001`,
        seq: 1,
        title: 'Group projects into portfolios',
        body: 'The sidebar will not hold nine of them, let alone twenty-three.',
        status: 'new',
      },
      {
        projectId: project.id,
        humanId: `${CODE}-IDEA-002`,
        seq: 2,
        title: 'A keyboard palette for jumping between records',
        body: 'Type a human ID from anywhere and land on it.',
        status: 'accepted',
        decidedAt: new Date('2026-09-15'),
      },
      {
        projectId: project.id,
        humanId: `${CODE}-IDEA-003`,
        seq: 3,
        title: 'Import the fourteen projects still only in the vault',
        status: 'parked',
        reason: 'Their plans are frozen and readable. Import one when work actually starts on it.',
        decidedAt: new Date('2026-09-16'),
      },
      {
        projectId: project.id,
        humanId: `${CODE}-IDEA-004`,
        seq: 4,
        title: 'Comments and assignees on tasks',
        status: 'rejected',
        reason: 'Single operator, by design — FRM-REQ-099 asserts their absence.',
        decidedAt: new Date('2026-09-17'),
      },
    ],
  });

  // Project ideas: ecosystem-wide, so they are seeded once rather than per project. One of each
  // status including a converted one, which is the only status the screen cannot produce itself.
  await db.projectIdea.deleteMany({ where: { humanId: { startsWith: 'PI-' } } });
  await db.$executeRawUnsafe(`select setval('project_idea_seq', 1, false)`);
  for (const idea of [
    {
      // A full canvas, so the idea page — and the axe sweep over it — sees every part in use:
      // written sections, a Mermaid sketch, checklists, links, tags and a related project.
      title: 'A print notifier for the Bambu',
      pitch: 'Texts you when a print finishes. MQTT on the LAN, the cloud as a fallback.',
      status: 'new' as const,
      problem: 'Long prints fail **silently**, and the failure is found hours later.',
      audience: 'One printer, prints left overnight.',
      approach: '```mermaid\ngraph LR\n  printer -- MQTT --> worker -- SMS --> phone\n```',
      whyNow: 'The printer runs most nights now.',
      risks: '- A firmware update could close the LAN MQTT port.',
      excitement: 4,
      tags: ['home-lab', 'hardware'],
      questions: [
        { id: 'q1', text: 'Does LAN mode expose print progress?', done: true },
        { id: 'q2', text: 'Is SMS the right channel?', done: false },
      ],
      nextSteps: [{ id: 's1', text: 'Capture a night of MQTT messages', done: false }],
      links: [{ id: 'l1', label: 'Bambu MQTT notes', url: 'https://example.com/bambu-mqtt' }],
      related: ['EXMP'],
    },
    {
      title: 'An offline-first field notebook',
      pitch: 'Capture on a phone with no signal, reconcile later. The sync is the whole problem.',
      status: 'considering' as const,
    },
    {
      title: 'A self-hosted status page',
      status: 'parked' as const,
      reason: 'Foreman’s health screen already answers this for the only operator who asks.',
    },
    {
      title: 'A second chat client',
      status: 'rejected' as const,
      reason: 'D3 Chat exists. A second one is a rewrite wearing a new name.',
    },
  ]) {
    const rows = await db.$queryRawUnsafe<{ seq: number }[]>(
      `select nextval('project_idea_seq')::int as seq`,
    );
    const seq = rows[0]?.seq ?? 0;
    await db.projectIdea.create({
      data: {
        humanId: `PI-${String(seq).padStart(3, '0')}`,
        seq,
        ...idea,
        ...(idea.status === 'new' ? {} : { decidedAt: new Date('2026-09-18') }),
      },
    });
  }

  await db.term.createMany({
    data: [
      {
        projectId: project.id,
        term: 'Attribution',
        definition: 'The link between a commit and the task it advanced.',
        aliases: ['commit attribution'],
      },
      // A null project means the term is ecosystem-wide.
      {
        term: 'Exit gate',
        definition: 'The conditions a phase must satisfy before it can be called complete.',
        aliases: ['exit demo'],
      },
    ],
  });

  // Documents: several kinds, with addressable sections, a Mermaid diagram and a real revision.
  const SECTIONS: Record<string, { key: string; heading: string; bodyMd: string }[]> = {
    architecture: [
      {
        key: 'summary',
        heading: 'Summary',
        bodyMd: `What this document is for, citing ${CODE}-REQ-001 — which makes this section a backlink on that requirement.`,
      },
      {
        key: 'deployment',
        heading: 'Deployment',
        bodyMd: [
          'The section an MCP resource URI resolves to, on its own.',
          '',
          '```mermaid',
          'graph TB',
          '  tunnel[Cloudflare Tunnel] --> server[Foreman server]',
          '  server --> db[(PostgreSQL 16)]',
          '  server --> worker[Job worker]',
          '  worker --> db',
          '```',
          '',
          'No host ports: the tunnel is the only way in.',
        ].join('\n'),
      },
    ],
  };

  const DEFAULT_SECTIONS = [
    { key: 'summary', heading: 'Summary', bodyMd: `What this document is for, citing ${CODE}-REQ-001.` },
    {
      key: 'deployment',
      heading: 'Deployment',
      bodyMd: 'The section an MCP resource URI resolves to, on its own.',
    },
  ];

  for (const kind of [
    'architecture',
    'data_model',
    'ux_flows',
    'phase_plan',
    'research',
    // The prose ancestor of the ideas screen. Seeded so the link from that screen back to this
    // document is exercised rather than assumed: four real projects carry one, and a records
    // screen that cannot reach the document it succeeds is how the two quietly disagree.
    'feature_ideas',
  ] as const) {
    const sections = SECTIONS[kind] ?? DEFAULT_SECTIONS;
    const document = await db.document.create({
      data: {
        projectId: project.id,
        kind,
        title: kind.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase()),
        ...(kind === 'phase_plan' ? { phaseId: p1.id } : {}),
        sourcePath: `D3 Cloud Vault/Example Project/${kind}.md`,
        sections: {
          create: sections.map((section, order) => ({ ...section, sortOrder: order })),
        },
      },
    });

    // The snapshot is the document as it stood — the shape a diff reads. An ad-hoc one makes the
    // history unreadable from that revision backwards.
    await db.documentRevision.create({
      data: {
        documentId: document.id,
        revisionNo: 1,
        snapshot: {
          title: document.title,
          kind: document.kind,
          sections: sections.map((section, order) => ({ ...section, sortOrder: order })),
        },
        actor: 'seed',
        actorKind: 'importer',
        note: 'As imported.',
      },
    });
  }

  // Audits and findings: every kind, every severity, every status.
  const audits = await Promise.all(
    (['code_review', 'design', 'feature', 'api'] as const).map((kind, index) =>
      db.audit.create({
        data: {
          projectId: project.id,
          humanId: `${CODE}-AUD-${String(index + 1).padStart(3, '0')}`,
          kind,
          scope: 'the whole project',
          runDate: new Date('2026-09-1' + String(index + 1)),
          verdict: index === 0 ? 'Two Highs, both fixed.' : 'Nothing critical.',
          rounds: index + 1,
          status: (['complete', 'complete', 'running', 'abandoned'] as const)[index] ?? 'complete',
        },
      }),
    ),
  );

  const severities = ['critical', 'high', 'medium', 'low'] as const;
  const statuses = ['open', 'fixed', 'skipped', 'wont_fix'] as const;
  await Promise.all(
    severities.map((severity, index) =>
      db.finding.create({
        data: {
          projectId: project.id,
          auditId: audits[index % audits.length]?.id ?? null,
          humanId: `${CODE}-CR-${String(index + 1).padStart(3, '0')}`,
          title: `A ${severity} finding`,
          lenses: ['correctness', 'security'].slice(0, (index % 2) + 1),
          severity,
          confidence: 'high',
          verified: index % 2 === 0 ? 'confirmed' : 'plausible',
          status: statuses[index] ?? 'open',
          foundRound: 1,
          ...(statuses[index] === 'fixed'
            ? { fixedRound: 2, fixedCommitSha: 'c0175a6' }
            : {}),
          effort: 'S',
          // A real location's shape: several files, ranges, and prose the parse keeps as a note.
          locationRaw:
            'apps/server/src/example.ts:196-206, 299-310; apps/web/src/App.tsx:12 (no guard)',
          observedMd: `What was seen, and why it is ${severity}.`,
          recommendationMd: 'What to do about it.',
          requirementId: requirements[index]?.id ?? null,
          adrId: adrs[index % adrs.length]?.id ?? null,
          phaseId: phases[index % phases.length]?.id ?? null,
          // Parsed rows beside the raw string, the way a real write does it.
          locations: {
            create: parseLocation(
              'apps/server/src/example.ts:196-206, 299-310; apps/web/src/App.tsx:12 (no guard)',
            ).map((location, order) => ({ ...location, sortOrder: order })),
          },
        },
      }),
    ),
  );

  // The finding the recurrence engine is meant to catch: the same shape of problem as the
  // neighbour's, in different words. Bindery's real "five modal overlays have no dialog
  // semantics" is the case this stands in for.
  await db.finding.create({
    data: {
      projectId: project.id,
      auditId: audits[1]?.id ?? null,
      humanId: `${CODE}-DA-001`,
      title: 'Five modal overlays have no dialog semantics',
      lenses: ['accessibility'],
      severity: 'high',
      confidence: 'high',
      verified: 'unverified',
      status: 'open',
      foundRound: 1,
      effort: 'M',
      locationRaw: 'apps/web/src/features/edit/EditPanel.tsx:353; apps/web/src/screens/Modal.tsx:22',
      observedMd:
        'Each overlay is a plain div with no role, no focus trap and no labelled title, so a ' +
        'screen reader walks past it and keyboard focus stays on the page behind.',
      recommendationMd: 'Give each overlay a dialog role, a labelled title and a focus trap.',
      locations: {
        create: parseLocation(
          'apps/web/src/features/edit/EditPanel.tsx:353; apps/web/src/screens/Modal.tsx:22',
        ).map((location, order) => ({ ...location, sortOrder: order })),
      },
    },
  });

  /**
   * A second project, minimal, existing for one reason: **recurrence is cross-project**, and a
   * seed with one project cannot demonstrate the feature that justifies Phase 6. Both findings
   * below describe the same problem in different words, which is exactly the case the overlap
   * scoring has to catch.
   */
  const other = await db.project.create({
    data: {
      code: OTHER_CODE,
      name: 'Neighbour Project',
      slug: 'neighbour-project',
      lifecycle: 'building',
      pitch: 'A second project, so the findings inbox and recurrence have more than one.',
    },
  });
  // Both join the end of the ungrouped, so positions stay 0..n-1 (FRM-REQ-226).
  const seedActor = { actor: 'seed', actorKind: 'system' as const };
  await settleInserted(db, seedActor, project.id, `${CODE} seeded`);
  await settleInserted(db, seedActor, other.id, `${OTHER_CODE} seeded`);

  const neighbourAudit = await db.audit.create({
    data: {
      projectId: other.id,
      humanId: `${OTHER_CODE}-AUD-001`,
      kind: 'design',
      scope: 'the console',
      runDate: new Date('2026-09-12'),
      verdict: 'One accessibility problem worth fixing.',
      rounds: 1,
      status: 'complete',
    },
  });

  for (const [index, finding] of [
    {
      title: 'The confirmation overlay has no dialog role or focus trap',
      severity: 'high' as const,
      lenses: ['accessibility'],
      observedMd:
        'The overlay is a plain div: no role, no focus trap, no labelled title. A screen reader ' +
        'walks straight past it and keyboard focus stays on the page behind.',
      location: 'web/src/features/settings/Confirm.tsx:88-140',
    },
    {
      title: 'A query runs once per row in the export path',
      severity: 'medium' as const,
      lenses: ['performance', 'data'],
      observedMd: 'The loop issues one select per row returned by the outer query.',
      location: 'api/export/run.py:212-240',
    },
  ].entries()) {
    await db.finding.create({
      data: {
        projectId: other.id,
        auditId: neighbourAudit.id,
        humanId: `${OTHER_CODE}-DA-${String(index + 1).padStart(3, '0')}`,
        title: finding.title,
        lenses: finding.lenses,
        severity: finding.severity,
        confidence: 'high',
        // What 123 of the 127 real findings say.
        verified: 'unverified',
        status: 'open',
        foundRound: 1,
        effort: 'M',
        locationRaw: finding.location,
        observedMd: finding.observedMd,
        recommendationMd: 'What to do about it.',
        locations: {
          create: parseLocation(finding.location).map((location, order) => ({
            ...location,
            sortOrder: order,
          })),
        },
      },
    });
  }

  // Ingested reality: a repo, commits, an attribution of each kind, check runs, a release and a
  // deployment. The unconfirmed attribution is the important row — it is a proposal, not a fact.
  const repo = await db.repo.create({
    data: {
      projectId: project.id,
      fullName: 'matdemers1/example-project',
      defaultBranch: 'main',
      backfilledAt: new Date(),
    },
  });

  const sources = ['declared', 'message', 'file_overlap'] as const;
  for (const [index, source] of sources.entries()) {
    const commit = await db.commit.create({
      data: {
        repoId: repo.id,
        sha: randomBytes(20).toString('hex'),
        message: `${CODE}-T-0.${String(index + 1)}: a commit attributed by ${source}`,
        author: 'matt',
        authorEmail: 'matt@example.com',
        committedAt: new Date(Date.now() - index * 86_400_000),
        additions: 120 + index,
        deletions: 8 + index,
        files: { create: [{ path: `apps/server/src/0-${String(index + 1)}.ts`, status: 'modified' }] },
      },
    });

    await db.commitTask.create({
      data: {
        commitId: commit.id,
        taskId: tasks[index]?.id ?? '',
        source,
        confidence: source === 'declared' ? 1 : source === 'message' ? 0.8 : 0.4,
        // Only the declared one is a fact. The file-overlap row is the one that must never be
        // read as truth (ADR-005, never-regress test #1).
        confirmed: source === 'declared',
        ...(source === 'declared' ? { confirmedAt: new Date(), confirmedBy: 'seed' } : {}),
        evidence: { note: `attributed by ${source}` },
      },
    });

    await db.checkRun.create({
      data: {
        repoId: repo.id,
        commitSha: commit.sha,
        name: 'ci',
        conclusion: (['success', 'failure', 'skipped'] as const)[index] ?? 'success',
        startedAt: new Date(Date.now() - index * 86_400_000),
        completedAt: new Date(Date.now() - index * 86_400_000 + 120_000),
      },
    });
  }

  // Two commits that are not proposals: one nothing explains, and one the remote no longer has.
  // Both are states the Activity screen has to render, and both are easy to get wrong by
  // accident — an unattributed commit is the coverage gap (R-02), and an orphan is history that
  // was rewritten but is still cited.
  await db.commit.create({
    data: {
      repoId: repo.id,
      sha: randomBytes(20).toString('hex'),
      message: 'Tidy the imports and fix a typo',
      author: 'matt',
      authorEmail: 'matt@example.com',
      committedAt: new Date(Date.now() - 4 * 86_400_000),
      files: { create: [{ path: 'apps/web/src/App.tsx', status: 'modified' }] },
    },
  });

  await db.commit.create({
    data: {
      repoId: repo.id,
      sha: randomBytes(20).toString('hex'),
      message: 'A commit whose SHA a force push rewrote',
      author: 'matt',
      committedAt: new Date(Date.now() - 5 * 86_400_000),
      orphanedAt: new Date(),
    },
  });

  await db.release.create({
    data: {
      repoId: repo.id,
      tag: 'v0.1.0',
      name: 'First release',
      bodyMd: 'What shipped.',
      publishedAt: new Date(),
    },
  });

  await db.deployment.create({
    data: {
      projectId: project.id,
      environment: 'production',
      image: 'ghcr.io/matdemers1/example-project',
      imageSha: randomBytes(20).toString('hex'),
      schemaRevision: '20260918035203_init',
      deployedAt: new Date(),
      note: 'The standing rule: every push reports its SHA per image and its schema revision.',
    },
  });

  await db.techItem.createMany({
    data: [
      { projectId: project.id, name: 'PostgreSQL', category: 'database', version: '16', role: 'system of record' },
      { projectId: project.id, name: 'React', category: 'frontend', version: '19', role: 'console' },
      { projectId: project.id, name: 'Express', category: 'backend', version: '5', role: 'API' },
    ],
  });

  // A citation edge, which is what makes backlinks possible.
  await db.reference.create({
    data: {
      fromType: 'task',
      fromId: tasks[0]?.id ?? '',
      toType: 'requirement',
      toId: requirements[0]?.id ?? '',
      kind: 'satisfies',
      citedAs: `${CODE}-REQ-001`,
    },
  });

  // A job with stages, in every state, so the queue screen has something to render.
  const job = await db.job.create({
    data: {
      kind: 'example',
      payload: { note: 'seeded' },
      status: 'failed',
      attempts: 1,
      lastError: 'second: the network went away',
      stages: {
        create: [
          { name: 'first', sortOrder: 0, status: 'succeeded', output: { step: 1 }, attempts: 1 },
          {
            name: 'second',
            sortOrder: 1,
            status: 'failed',
            attempts: 1,
            lastError: 'the network went away',
          },
          { name: 'third', sortOrder: 2, status: 'queued' },
        ],
      },
    },
  });

  await db.importRecord.createMany({
    data: [
      {
        jobId: job.id,
        sourcePath: 'D3 Cloud Vault/Example Project/Scope of Work.md',
        entityType: 'phase',
        entityId: p0.id,
        status: 'mapped',
        sourceBytes: 12_400,
      },
      {
        jobId: job.id,
        sourcePath: 'D3 Cloud Vault/Example Project/Research Notes.md',
        status: 'partial',
        note: 'Sections after "Appendix" were not recognised.',
        sourceBytes: 8_200,
      },
      {
        jobId: job.id,
        sourcePath: 'D3 Cloud Vault/Example Project/Scratch.md',
        status: 'unmapped',
        note: 'No front matter and no recognisable structure.',
        sourceBytes: 300,
      },
    ],
  });

  await record(db, {
    actor: 'seed',
    actorKind: 'system',
    action: 'create',
    entityType: 'project',
    entityId: project.id,
    entityHumanId: CODE,
    after: { seeded: true },
  });

  // An operator to sign in as. Only ever created when one does not exist, and never with a
  // password from the source: a seeded credential that is also a published one is a back door.
  const email = config.OPERATOR_EMAIL;
  if (email !== undefined) {
    const existingUser = await db.user.findUnique({ where: { email } });
    if (existingUser === null) {
      const user = await db.user.create({
        data: {
          email,
          displayName: config.OPERATOR_DISPLAY_NAME ?? 'Operator',
          status: 'active',
        },
      });
      const password = process.env['OPERATOR_PASSWORD'] ?? randomBytes(18).toString('base64url');
      await setPassword({ db, config }, user.id, password);
      process.stdout.write(
        process.env['OPERATOR_PASSWORD'] === undefined
          ? `\ncreated ${email} with a generated password:\n\n    ${password}\n\nIt is not stored anywhere else. Change it after signing in.\n\n`
          : `\ncreated ${email} with the password from OPERATOR_PASSWORD\n\n`,
      );
    } else {
      process.stdout.write(`${email} already exists; leaving its password alone\n`);
    }
  }

  const counts = await Promise.all([
    db.phase.count({ where: { projectId: project.id } }),
    db.requirement.count({ where: { projectId: project.id } }),
    db.task.count({ where: { projectId: project.id } }),
    db.finding.count({ where: { projectId: project.id } }),
    db.document.count({ where: { projectId: project.id } }),
  ]);
  process.stdout.write(
    `seeded ${CODE}: ${String(counts[0])} phases, ${String(counts[1])} requirements, ` +
      `${String(counts[2])} tasks, ${String(counts[3])} findings, ${String(counts[4])} documents\n`,
  );
}

const config = loadConfig();
const db = createDb(config.DATABASE_URL);
try {
  await seed(db, config);
} finally {
  await db.$disconnect();
}
