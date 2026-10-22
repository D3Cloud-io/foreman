import {
  AdrCreate,
  AdrUpdate,
  DecisionCreate,
  DecisionUpdate,
  DocumentCreate,
  DocumentKind,
  DocumentUpdate,
  DecisionsQuery,
  PageQuery,
  IdeaCreate,
  IdeaUpdate,
  RiskCreate,
  RiskUpdate,
  SectionCreate,
  SectionUpdate,
  TermCreate,
  TermUpdate,
} from '@foreman/shared';
import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, requireScope } from '../auth/middleware.js';
import type { Db } from '../db.js';
import {
  addSection,
  createDocument,
  diffRevisions,
  findDocument,
  revisionsOf,
  updateDocument,
  updateSection,
} from '../domain/documents.js';
import {
  adrGraph,
  createAdr,
  createDecision,
  createRisk,
  createTerm,
  driftAcceptances,
  glossaryFor,
  updateAdr,
  updateDecision,
  updateRisk,
  termOccurrences,
  updateTerm,
} from '../domain/record.js';
import { findProject } from '../domain/projects.js';
import { createIdea, ideasFor, updateIdea } from '../domain/ideas.js';
import { softDelete } from '../domain/undo.js';
import {
  documentAt,
  renderDocument,
  renderSection,
  resourceCatalogue,
  sectionAt,
} from '../domain/resources.js';
import { assertFresh, setEtag } from './concurrency.js';
import { actorOf, decodeCursor, encodeCursor, handler, param, parseBody, parseQuery } from './helpers.js';
import { noContentWithEvents } from './undo.js';

/**
 * The record over HTTP: documents and sections, ADRs, decisions, risks and glossary terms.
 *
 * The endpoint this phase exists for is `PUT /documents/:id/sections/:key` — the one Bindery never
 * had, and the reason its titles and correspondents still cannot be corrected at all.
 */
export function recordRoutes(db: Db): Router {
  const router = Router();
  router.use(requireAuth);
  router.use(requireScope(db, 'read'));
  const canWrite = requireScope(db, 'write');

  // ─── Documents ───────────────────────────────────────────────────────────

  const DocumentQuery = PageQuery.extend({ kind: DocumentKind.optional() });

  router.get(
    '/:code/documents',
    handler(async (req, res) => {
      const query = parseQuery(DocumentQuery, req, res);
      if (query === null) return;
      const project = await findProject(db, param(req, 'code'));
      const after = decodeCursor(query.cursor);

      const filters = {
        projectId: project.id,
        deletedAt: null,
        ...(query.kind === undefined ? {} : { kind: query.kind }),
      };
      const rows = await db.document.findMany({
        where: { ...filters, ...(after === null ? {} : { title: { gt: after } }) },
        orderBy: { title: 'asc' },
        take: query.limit + 1,
        include: {
          phase: { select: { humanId: true, name: true } },
          // The section list, not the section bodies: a document listing that carries every body
          // is a listing that gets slower the more anybody writes.
          sections: {
            where: { deletedAt: null },
            orderBy: { sortOrder: 'asc' },
            select: { key: true, heading: true, sortOrder: true },
          },
        },
      });

      const items = rows.slice(0, query.limit);
      res.json({
        items,
        nextCursor: rows.length > query.limit ? encodeCursor(items.at(-1)?.title ?? '') : null,
        total: await db.document.count({ where: filters }),
      });
    }),
  );

  router.post(
    '/:code/documents',
    canWrite,
    handler(async (req, res) => {
      const body = parseBody(DocumentCreate, req, res);
      if (body === null) return;
      res.status(201).json(await createDocument(db, actorOf(req), param(req, 'code'), body));
    }),
  );

  router.get(
    '/:code/documents/:id',
    handler(async (req, res) => {
      const document = await findDocument(db, param(req, 'id'));
      setEtag(res, document);
      res.json(document);
    }),
  );

  router.patch(
    '/:code/documents/:id',
    canWrite,
    handler(async (req, res) => {
      const body = parseBody(DocumentUpdate, req, res);
      if (body === null) return;

      const id = param(req, 'id');
      assertFresh(req, await findDocument(db, id));
      const document = await updateDocument(db, actorOf(req), id, body);
      setEtag(res, document);
      res.json(document);
    }),
  );

  // ─── Sections ────────────────────────────────────────────────────────────

  /**
   * The single-section write (FRM-REQ-063).
   *
   * `PUT` rather than `PATCH`: the body replaces the section's content outright, and a partial
   * markdown update is not a thing that means anything.
   */
  router.put(
    '/:code/documents/:id/sections/:key',
    canWrite,
    handler(async (req, res) => {
      const body = parseBody(SectionUpdate, req, res);
      if (body === null) return;

      const id = param(req, 'id');
      // `If-Match` is checked against the document, not the section: an edit is safe when nothing
      // else has moved under it, and the revision number is per document.
      assertFresh(req, await findDocument(db, id));

      const section = await updateSection(db, actorOf(req), id, param(req, 'key'), body);
      res.json(section);
    }),
  );

  router.post(
    '/:code/documents/:id/sections',
    canWrite,
    handler(async (req, res) => {
      const body = parseBody(SectionCreate, req, res);
      if (body === null) return;
      res.status(201).json(await addSection(db, actorOf(req), param(req, 'id'), body));
    }),
  );

  // ─── Addressed by URI (T-4.9) ────────────────────────────────────────────

  /**
   * The read behind `foreman://<code>/architecture#deployment`.
   *
   * The address is the document's kind where that is unambiguous, so the URI a person would guess
   * is the URI that works.
   */
  router.get(
    '/:code/documents/at/:address',
    handler(async (req, res) => {
      const document = await documentAt(db, param(req, 'code'), param(req, 'address'));
      res.json({ ...document, markdown: renderDocument(document) });
    }),
  );

  router.get(
    '/:code/documents/at/:address/sections/:key',
    handler(async (req, res) => {
      const { document, section } = await sectionAt(
        db,
        param(req, 'code'),
        param(req, 'address'),
        param(req, 'key'),
      );
      res.json({
        ...section,
        document: { id: document.id, title: document.title, kind: document.kind },
        markdown: renderSection(section),
        // The glossary terms this section uses, so a reader need not go and look them up.
        terms: await termOccurrences(db, param(req, 'code'), section.bodyMd),
      });
    }),
  );

  router.get(
    '/:code/resources',
    handler(async (req, res) => {
      const items = await resourceCatalogue(db, param(req, 'code'));
      res.json({ items, nextCursor: null, total: items.length });
    }),
  );

  // ─── Revisions ───────────────────────────────────────────────────────────

  router.get(
    '/:code/documents/:id/revisions',
    handler(async (req, res) => {
      const items = await revisionsOf(db, param(req, 'id'));
      res.json({ items, nextCursor: null, total: items.length });
    }),
  );

  const DiffQuery = z.object({
    from: z.coerce.number().int().min(1),
    to: z.coerce.number().int().min(1),
  });

  router.get(
    '/:code/documents/:id/diff',
    handler(async (req, res) => {
      const query = parseQuery(DiffQuery, req, res);
      if (query === null) return;
      res.json(await diffRevisions(db, param(req, 'id'), query.from, query.to));
    }),
  );

  // ─── ADRs ────────────────────────────────────────────────────────────────

  const AdrQuery = PageQuery.extend({
    status: z.enum(['proposed', 'accepted', 'superseded', 'rejected']).optional(),
  });

  router.get(
    '/:code/adrs',
    handler(async (req, res) => {
      const query = parseQuery(AdrQuery, req, res);
      if (query === null) return;
      const project = await findProject(db, param(req, 'code'));
      const after = decodeCursor(query.cursor);

      const filters = {
        projectId: project.id,
        deletedAt: null,
        ...(query.status === undefined ? {} : { status: query.status }),
      };
      const rows = await db.adr.findMany({
        where: { ...filters, ...(after === null ? {} : { number: { gt: Number(after) } }) },
        orderBy: { number: 'asc' },
        take: query.limit + 1,
        include: {
          relations: {
            select: { kind: true, relatedAdr: { select: { humanId: true, title: true } } },
          },
        },
      });

      const items = rows.slice(0, query.limit);
      res.json({
        items,
        nextCursor:
          rows.length > query.limit ? encodeCursor(String(items.at(-1)?.number ?? '')) : null,
        total: await db.adr.count({ where: filters }),
      });
    }),
  );

  router.post(
    '/:code/adrs',
    canWrite,
    handler(async (req, res) => {
      const body = parseBody(AdrCreate, req, res);
      if (body === null) return;
      res.status(201).json(await createAdr(db, actorOf(req), param(req, 'code'), body));
    }),
  );

  router.patch(
    '/:code/adrs/:humanId',
    canWrite,
    handler(async (req, res) => {
      const body = parseBody(AdrUpdate, req, res);
      if (body === null) return;

      const humanId = param(req, 'humanId');
      const current = await db.adr.findFirst({ where: { humanId, deletedAt: null } });
      if (current !== null) assertFresh(req, current);

      const adr = await updateAdr(db, actorOf(req), humanId, body);
      setEtag(res, adr);
      res.json(adr);
    }),
  );

  /** The supersedes graph for the whole project — a chain is only legible whole (FRM-REQ-059). */
  router.get(
    '/:code/adrs-graph',
    handler(async (req, res) => {
      res.json(await adrGraph(db, param(req, 'code')));
    }),
  );

  // ─── Decisions ───────────────────────────────────────────────────────────

  router.get(
    '/:code/decisions',
    handler(async (req, res) => {
      const query = parseQuery(DecisionsQuery, req, res);
      if (query === null) return;

      // The decisions that accept drift, read by their link and paged by key, so the Drift tab
      // reads every one rather than the first page of a list ordered as text (FRM-T-18.15).
      if (query.acceptsDrift !== undefined) {
        const after = decodeCursor(query.cursor);
        if (after !== null && !/^[0-9a-f-]{36}$/i.test(after)) {
          res.status(400).json({ error: 'the cursor is not one this list issued', fields: [{ path: 'cursor', message: 'not a cursor from this list' }] });
          return;
        }
        const page = await driftAcceptances(db, param(req, 'code'), { limit: query.limit, after });
        res.json({ ...page, nextCursor: page.nextCursor === null ? null : encodeCursor(page.nextCursor) });
        return;
      }
      const project = await findProject(db, param(req, 'code'));

      const items = await db.decision.findMany({
        where: { projectId: project.id, deletedAt: null },
        orderBy: { humanId: 'asc' },
        take: query.limit,
      });
      res.json({ items, nextCursor: null, total: items.length });
    }),
  );

  router.post(
    '/:code/decisions',
    canWrite,
    handler(async (req, res) => {
      const body = parseBody(DecisionCreate, req, res);
      if (body === null) return;
      res.status(201).json(await createDecision(db, actorOf(req), param(req, 'code'), body));
    }),
  );

  router.patch(
    '/:code/decisions/:humanId',
    canWrite,
    handler(async (req, res) => {
      const body = parseBody(DecisionUpdate, req, res);
      if (body === null) return;
      res.json(await updateDecision(db, actorOf(req), param(req, 'humanId'), body));
    }),
  );

  // ─── Risks ───────────────────────────────────────────────────────────────

  const RiskQuery = PageQuery.extend({
    status: z.enum(['open', 'fired', 'closed']).optional(),
  });

  router.get(
    '/:code/risks',
    handler(async (req, res) => {
      const query = parseQuery(RiskQuery, req, res);
      if (query === null) return;
      const project = await findProject(db, param(req, 'code'));

      const items = await db.risk.findMany({
        where: {
          projectId: project.id,
          deletedAt: null,
          ...(query.status === undefined ? {} : { status: query.status }),
        },
        orderBy: { humanId: 'asc' },
        take: query.limit,
        include: { phase: { select: { humanId: true, name: true } } },
      });
      res.json({ items, nextCursor: null, total: items.length });
    }),
  );

  router.post(
    '/:code/risks',
    canWrite,
    handler(async (req, res) => {
      const body = parseBody(RiskCreate, req, res);
      if (body === null) return;
      res.status(201).json(await createRisk(db, actorOf(req), param(req, 'code'), body));
    }),
  );

  router.patch(
    '/:code/risks/:humanId',
    canWrite,
    handler(async (req, res) => {
      const body = parseBody(RiskUpdate, req, res);
      if (body === null) return;
      res.json(await updateRisk(db, actorOf(req), param(req, 'humanId'), body));
    }),
  );

  // ─── Audit index (T-4.12) ────────────────────────────────────────────────

  /**
   * The Audit Index, generated (FRM-REQ-073).
   *
   * The vault kept this as a hand-maintained `_Audit Index.md` that every audit skill appended to.
   * Here it is a count over the findings each audit produced — which cannot disagree with them.
   */
  router.get(
    '/:code/audits',
    handler(async (req, res) => {
      const project = await findProject(db, param(req, 'code'));
      const audits = await db.audit.findMany({
        where: { projectId: project.id, deletedAt: null },
        orderBy: [{ runDate: 'desc' }, { humanId: 'desc' }],
        include: {
          findings: {
            where: { deletedAt: null },
            select: { severity: true, status: true },
          },
        },
      });

      res.json({
        items: audits.map(({ findings, ...audit }) => ({
          ...audit,
          findings: {
            total: findings.length,
            open: findings.filter((f) => f.status === 'open').length,
            // Criticals and highs counted apart: they are what an index is read for.
            critical: findings.filter((f) => f.severity === 'critical').length,
            high: findings.filter((f) => f.severity === 'high').length,
          },
        })),
        nextCursor: null,
        total: audits.length,
      });
    }),
  );

  // ─── Glossary ────────────────────────────────────────────────────────────

  // ─── Ideas ───────────────────────────────────────────────────────────────

  router.get(
    '/:code/ideas',
    handler(async (req, res) => {
      const items = await ideasFor(db, param(req, 'code'));
      res.json({ items, nextCursor: null, total: items.length });
    }),
  );

  router.post(
    '/:code/ideas',
    canWrite,
    handler(async (req, res) => {
      const body = parseBody(IdeaCreate, req, res);
      if (body === null) return;
      res.status(201).json(await createIdea(db, actorOf(req), param(req, 'code'), body));
    }),
  );

  router.patch(
    '/:code/ideas/:humanId',
    canWrite,
    handler(async (req, res) => {
      const body = parseBody(IdeaUpdate, req, res);
      if (body === null) return;
      res.json(await updateIdea(db, actorOf(req), param(req, 'humanId'), body));
    }),
  );

  router.delete(
    '/:code/ideas/:humanId',
    canWrite,
    handler(async (req, res) => {
      const { auditEventIds } = await softDelete(db, actorOf(req), 'idea', param(req, 'humanId'));
      noContentWithEvents(res, auditEventIds);
    }),
  );

  router.get(
    '/:code/glossary',
    handler(async (req, res) => {
      const items = await glossaryFor(db, param(req, 'code'));
      res.json({ items, nextCursor: null, total: items.length });
    }),
  );

  router.post(
    '/:code/terms',
    canWrite,
    handler(async (req, res) => {
      const body = parseBody(TermCreate, req, res);
      if (body === null) return;
      res.status(201).json(await createTerm(db, actorOf(req), param(req, 'code'), body));
    }),
  );

  router.patch(
    '/:code/terms/:id',
    canWrite,
    handler(async (req, res) => {
      const body = parseBody(TermUpdate, req, res);
      if (body === null) return;
      res.json(await updateTerm(db, actorOf(req), param(req, 'id'), body));
    }),
  );

  return router;
}
