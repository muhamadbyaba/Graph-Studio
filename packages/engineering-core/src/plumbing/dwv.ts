/**
 * Drainage–Waste–Vent (DWV) NETWORK validation (plumbing spec §3 — drainage & venting). Per-pipe DFU
 * sizing, slope and Manning self-cleansing checks already exist; what a segment sizer cannot see is the
 * SYSTEM: does every fixture actually reach the sewer, and is every trap protected by a vent? Those are
 * graph-reachability questions — the same rigour the supply pressure solver brought to the supply side.
 *
 * Two independent trees: drainage rooted at the sewer outlet, venting rooted at the roof vent terminal.
 * A fixture that cannot reach the outlet is an orphaned drain; a fixture that cannot reach the vent
 * terminal is an unvented trap (a self-siphonage / code risk). Pure and deterministic — no invented data.
 */

export interface DwvFixtureInput {
  readonly id: string;
  readonly type?: string;
  readonly dfu: number;
}
export interface DwvEdgeInput {
  readonly id: string;
  readonly from: string;
  readonly to: string;
}

export interface DwvFixtureStatus {
  readonly id: string;
  readonly type: string;
  readonly dfu: number;
  readonly drained: boolean;
  readonly vented: boolean;
}
export interface DwvAnalysis {
  readonly active: boolean; // a sewer outlet + at least one fixture exist
  readonly hasVentSystem: boolean; // a roof terminal + vent piping exist
  readonly totalDfu: number; // system drainage load reaching the outlet
  readonly fixtures: readonly DwvFixtureStatus[];
  readonly unconnectedDrains: readonly string[]; // fixtures that never reach the outlet
  readonly unventedFixtures: readonly string[]; // fixtures that never reach the vent terminal
  readonly allDrained: boolean;
  readonly allVented: boolean;
  readonly assumptions: readonly string[];
}

const ASSUMPTIONS: readonly string[] = [
  'Drained = fixture reaches the sewer outlet through drainage pipe; vented = reaches the roof terminal through vent pipe.',
  'DFU load = sum of Drainage Fixture Units for fixtures that reach the outlet.',
  'Pneumatic (stack air-pressure) and trap-seal loss checks are out of scope for this connectivity pass.',
];

/** Node ids reachable from `root` over the given undirected edges. */
function reachable(root: string | null, edges: readonly DwvEdgeInput[]): Set<string> {
  const seen = new Set<string>();
  if (root == null) return seen;
  const adj = new Map<string, string[]>();
  const touch = (n: string) => { if (!adj.has(n)) adj.set(n, []); };
  touch(root);
  for (const e of edges) { touch(e.from); touch(e.to); adj.get(e.from)!.push(e.to); adj.get(e.to)!.push(e.from); }
  const q = [root]; seen.add(root);
  while (q.length) { const u = q.shift()!; for (const v of adj.get(u) ?? []) if (!seen.has(v)) { seen.add(v); q.push(v); } }
  return seen;
}

/** Validate drainage + vent connectivity and total DFU load. */
export function analyzeDwv(args: {
  readonly outletId: string | null;
  readonly ventRootId: string | null;
  readonly fixtures: readonly DwvFixtureInput[];
  readonly drainEdges: readonly DwvEdgeInput[];
  readonly ventEdges: readonly DwvEdgeInput[];
}): DwvAnalysis {
  const active = args.outletId != null && args.fixtures.length > 0;
  const hasVentSystem = args.ventRootId != null && args.ventEdges.length > 0;
  if (!active) {
    return { active: false, hasVentSystem, totalDfu: 0, fixtures: [], unconnectedDrains: [], unventedFixtures: [], allDrained: true, allVented: true, assumptions: ASSUMPTIONS };
  }

  const drainedSet = reachable(args.outletId, args.drainEdges);
  const ventedSet = hasVentSystem ? reachable(args.ventRootId, args.ventEdges) : new Set<string>();

  const fixtures: DwvFixtureStatus[] = args.fixtures.map((f) => ({
    id: f.id, type: f.type ?? 'fixture', dfu: f.dfu,
    drained: drainedSet.has(f.id),
    vented: hasVentSystem && ventedSet.has(f.id),
  }));

  const unconnectedDrains = fixtures.filter((f) => !f.drained).map((f) => f.id);
  const unventedFixtures = fixtures.filter((f) => !f.vented).map((f) => f.id);
  const totalDfu = fixtures.reduce((s, f) => s + (f.drained ? f.dfu : 0), 0);

  return {
    active: true, hasVentSystem, totalDfu, fixtures,
    unconnectedDrains, unventedFixtures,
    allDrained: unconnectedDrains.length === 0,
    allVented: hasVentSystem && unventedFixtures.length === 0,
    assumptions: ASSUMPTIONS,
  };
}
