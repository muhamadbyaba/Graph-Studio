import {
  JURISDICTIONS, autoRouteEdges, fitSegmentsToBox, jurisdictionList, round, sliceMeshAtZ, zRange,
} from '@buildgraph/engineering-core';
import type { LayoutEvent } from '@buildgraph/engineering-core';
import type { RequestContext, Router } from '../app.ts';
import { badRequest } from '../http/errors.ts';
import { SEED_EVENTS } from '../model/documents.ts';
import { serializeDocument } from '../model/serialize.ts';
import { validateEvents } from '../model/validate-events.ts';

/**
 * The design API: read the model, apply edits, undo, and run the assisted-design operations.
 *
 * Every edit is a `LayoutEvent` appended to the workspace's log. Nothing here computes engineering
 * — the engine does that when the state is read — so this layer's whole job is to validate the
 * request, apply it as a transaction, and fan the new state out to collaborators.
 */
export function registerDesignRoutes(router: Router): void {
  router.get('/api/state', async (ctx) => {
    const { doc } = await ctx.document();
    ctx.respond.json(serializeDocument(doc));
  });

  router.get('/api/jurisdictions', async (ctx) => {
    const { doc } = await ctx.document();
    ctx.respond.json({ jurisdictions: jurisdictionList(), active: doc.pack.id, ai: ctx.config.ai.enabled });
  });

  router.post('/api/jurisdiction', async (ctx) => {
    const body = await ctx.body<{ id?: unknown }>(4096);
    const id = String(body.id ?? '');
    const pack = JURISDICTIONS[id];
    if (pack === undefined) throw badRequest(`Unknown jurisdiction "${id.slice(0, 40)}"`);

    const { doc } = await ctx.document();
    // The same event log is re-folded under the new code constants: nothing is rewritten, every
    // size and check is simply recomputed against a different rule set.
    doc.setJurisdiction(pack);
    ctx.commit(doc);
  });

  router.post('/api/command', async (ctx) => {
    const body = await ctx.body<unknown>();
    const events = validateEvents(body, ctx.config.limits.eventsPerRequest);

    const { doc } = await ctx.document();
    // All-or-nothing: if any event leaves the model unfoldable, none of them are kept.
    doc.apply(events);
    ctx.commit(doc);
  });

  router.post('/api/load', async (ctx) => {
    const body = await ctx.body<{ events?: unknown }>();
    if (!Array.isArray(body.events)) throw badRequest('Expected { "events": [...] }');
    const events = validateEvents(body.events, ctx.config.limits.eventsPerDocument);

    const { doc } = await ctx.document();
    doc.replaceAll(events);
    ctx.commit(doc);
  });

  router.post('/api/undo', async (ctx) => {
    const { doc } = await ctx.document();
    doc.history.undo();
    ctx.commit(doc);
  });

  router.post('/api/redo', async (ctx) => {
    const { doc } = await ctx.document();
    doc.history.redo();
    ctx.commit(doc);
  });

  router.post('/api/reset', async (ctx) => {
    const { doc } = await ctx.document();
    doc.replaceAll(SEED_EVENTS);
    ctx.commit(doc);
  });

  router.post('/api/project-meta', async (ctx) => {
    const body = await ctx.body<Record<string, unknown>>(8192);
    const field = (value: unknown): string => String(value ?? '').replace(/[\p{Cc}\p{Cf}]/gu, '').trim().slice(0, 120);

    const { doc } = await ctx.document();
    doc.meta = {
      title: field(body.title),
      client: field(body.client),
      engineer: field(body.engineer),
      projectNo: field(body.projectNo),
      revision: field(body.revision),
    };
    ctx.commit(doc);
  });

  registerAssistRoutes(router);
}

/**
 * Assisted design: operations that generate edits rather than accepting them.
 *
 * These stay deterministic on purpose. Auto-routing is a minimum spanning tree over the plan
 * positions; fixing slopes reads each failing drain's own computed minimum. Neither invents a
 * number, and both produce ordinary events, so the results undo like anything a person drew.
 */
function registerAssistRoutes(router: Router): void {
  router.post('/api/autoroute', async (ctx) => {
    const body = await ctx.body<{ medium?: unknown }>(4096);
    const medium = String(body.medium ?? 'cold');

    const plan = ROUTE_PLANS[medium];
    if (plan === undefined) throw badRequest(`Cannot auto-route "${medium.slice(0, 20)}"`);

    const { doc } = await ctx.document();
    const layout = doc.history.state();
    const nodes = [...layout.nodes.values()];

    const root = nodes.find((n) => n.kind === plan.rootKind);
    if (root === undefined) throw badRequest(`Place a ${plan.rootLabel} first, then auto-route`);

    const terminals = nodes.filter((n) => n.kind === plan.terminalKind);
    if (terminals.length === 0) throw badRequest(`Place some ${plan.terminalLabel} first`);

    const points = [
      { id: root.id, x: root.x.get(), y: root.y.get() },
      ...terminals.map((t) => ({ id: t.id, x: t.x.get(), y: t.y.get() })),
    ];
    // Only skip a pair that is already joined *by this medium* — a cold run between two nodes must
    // not suppress the drainage run between the same two nodes.
    const existing = new Set(
      [...layout.pipes.values()].filter((p) => p.medium === medium).map((p) => [p.from, p.to].sort().join('~')),
    );

    const stamp = Date.now().toString(36);
    const events: LayoutEvent[] = [];
    for (const [from, to] of autoRouteEdges(points, root.id)) {
      if (existing.has([from, to].sort().join('~'))) continue;
      events.push({ type: 'PipeAdded', id: `p_ar_${stamp}_${events.length}`, from, to, medium } as LayoutEvent);
    }
    // Nothing left to connect is a legitimate outcome, not a failure: answer with the current
    // state and a notice the UI can show, rather than an error the user has to interpret.
    if (events.length > 0) doc.apply(events);
    ctx.commit(doc, events.length > 0
      ? { applied: events.length, notice: `Routed ${events.length} new ${medium} run(s)` }
      : { applied: 0, notice: 'Everything on this system is already connected' });
  });

  router.post('/api/fix-slopes', async (ctx) => {
    const { doc } = await ctx.document();
    const layout = doc.history.state();

    const events: LayoutEvent[] = [];
    for (const pipe of layout.pipes.values()) {
      if (pipe.medium !== 'drainage' || pipe.slopeCheck === null) continue;
      const check = pipe.slopeCheck.get();
      // `value` is the code minimum for this diameter, computed by the rule itself.
      if (check.pass === false && typeof check.value === 'number') {
        events.push({ type: 'PipeSlopeChanged', id: pipe.id, slopePct: check.value });
      }
    }
    if (events.length > 0) doc.apply(events);
    ctx.commit(doc, events.length > 0
      ? { applied: events.length, notice: `Set ${events.length} drain(s) to their minimum slope` }
      : { applied: 0, notice: 'Every drainage run already meets its minimum slope' });
  });

  /**
   * Section-cut an imported building model into a traceable 2D floor plan.
   *
   * The browser parses the IFC (the parser is WebAssembly and belongs client-side) and posts the
   * resulting triangle soup; the server intersects it with a horizontal plane and fits the wall
   * segments to the canvas. Meshes are large, so this route has its own body ceiling, its own
   * triangle ceiling and its own rate limit.
   */
  router.post('/api/ifc-plan', async (ctx: RequestContext) => {
    ctx.services.limiters.heavy.check(ctx.requireUser().id);

    const body = await ctx.body<{
      positions?: unknown; indices?: unknown; cutFraction?: unknown; cutZ?: unknown; box?: { w?: unknown; h?: unknown };
    }>(ctx.config.limits.meshBodyBytes);

    const positions = numberArray(body.positions, 'positions', 3_000_000);
    const indices = numberArray(body.indices, 'indices', 3_000_000);
    if (positions.length < 9 || indices.length < 3) throw badRequest('A mesh needs at least one triangle');
    if (positions.length % 3 !== 0) throw badRequest('"positions" must be a flat list of x, y, z triples');
    if (indices.length % 3 !== 0) throw badRequest('"indices" must be a flat list of triangle corners');

    const { min, max } = zRange(positions);
    const fraction = typeof body.cutFraction === 'number' && Number.isFinite(body.cutFraction)
      ? Math.min(0.98, Math.max(0.02, body.cutFraction))
      : 0.5;
    const cutZ = typeof body.cutZ === 'number' && Number.isFinite(body.cutZ) ? body.cutZ : min + fraction * (max - min);

    const width = clampDimension(body.box?.w, 26);
    const height = clampDimension(body.box?.h, 15);
    const segments = fitSegmentsToBox(sliceMeshAtZ(positions, indices, cutZ), width, height, 1);

    ctx.respond.json({
      segments, count: segments.length,
      cutZ: round(cutZ, 3), zMin: round(min, 3), zMax: round(max, 3),
    });
  });

  router.post('/api/ask', async (ctx) => {
    const user = ctx.requireUser();
    ctx.services.limiters.copilot.check(user.id);

    const body = await ctx.body<{ question?: unknown; selectedPipeId?: unknown }>(16_384);
    const question = String(body.question ?? '').trim();
    if (question.length === 0) throw badRequest('Ask a question');

    const selected = body.selectedPipeId === undefined || body.selectedPipeId === null
      ? undefined
      : String(body.selectedPipeId).slice(0, 64);

    const { doc } = await ctx.document();
    const answer = await ctx.services.copilot.ask(doc.history.state(), serializeDocument(doc), question, selected);
    ctx.respond.json(answer);
  });
}

interface RoutePlan {
  readonly rootKind: string;
  readonly rootLabel: string;
  readonly terminalKind: string;
  readonly terminalLabel: string;
}

const ROUTE_PLANS: Record<string, RoutePlan> = {
  cold: { rootKind: 'source', rootLabel: 'tank or source', terminalKind: 'fixture', terminalLabel: 'fixtures' },
  hot: { rootKind: 'source', rootLabel: 'tank or source', terminalKind: 'fixture', terminalLabel: 'fixtures' },
  drainage: { rootKind: 'outlet', rootLabel: 'sewer outlet', terminalKind: 'fixture', terminalLabel: 'fixtures' },
  vent: { rootKind: 'vent-terminal', rootLabel: 'roof vent terminal', terminalKind: 'fixture', terminalLabel: 'fixtures' },
  power: { rootKind: 'panel', rootLabel: 'distribution panel', terminalKind: 'load', terminalLabel: 'electrical loads' },
  air: { rootKind: 'ahu', rootLabel: 'air handling unit', terminalKind: 'diffuser', terminalLabel: 'diffusers' },
};

function numberArray(value: unknown, field: string, maxLength: number): number[] {
  if (!Array.isArray(value)) throw badRequest(`"${field}" must be an array of numbers`);
  if (value.length > maxLength) throw badRequest(`"${field}" exceeds the ${maxLength.toLocaleString('en-US')} element limit`);
  const out = new Array<number>(value.length);
  for (let i = 0; i < value.length; i++) {
    const n = value[i];
    if (typeof n !== 'number' || !Number.isFinite(n)) throw badRequest(`"${field}" contains a non-finite value at index ${i}`);
    out[i] = n;
  }
  return out;
}

function clampDimension(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(1000, Math.max(1, value));
}
