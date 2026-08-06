/**
 * Steady-state hydraulic NETWORK solver (plumbing spec §3 — pressure balance). Where `sizeSupplyPipeRule`
 * sizes one segment in isolation, this propagates the whole supply tree from the source to every outlet
 * and answers the question a segment sizer cannot: *does each fixture actually receive enough pressure?*
 *
 * Energy (Bernoulli, velocity head neglected) between a parent u and a child v joined by pipe e:
 *   z_v + p_v/ρg = z_u + p_u/ρg − h_f(e)
 * ⇒ residual head at v = residual head at u + (z_u − z_v) − h_f(e).
 * In gauge pressure (multiply head by ρg = 9.80665 kPa per metre of water):
 *   residual(v) = P_source + ρg·(z_source − z_v) − ρg·Σ h_f(source→v)
 *
 * h_f per segment is the Hazen–Williams loss already computed by the model for that segment's actual
 * simultaneous (Hunter) demand and routed length. This function only accumulates it along the tree —
 * it invents no numbers. Scope: friction on pipe runs + static (elevation) head. Velocity head and
 * minor (fitting) losses are excluded and declared in `assumptions`; they are added by the engineer as
 * an equivalent-length allowance until the fitting-loss module lands.
 */

/** Specific weight of water at ~20 °C: 1 m of head = 9.80665 kPa. */
export const RHO_G_KPA_PER_M = 9.80665;

export interface PressureNodeInput {
  readonly id: string;
  readonly z: number; // elevation [m]
  readonly isFixture: boolean;
  readonly type?: string;
  readonly x?: number; // plan position [m] — used to tell a straight run from a branch takeoff at a tee
  readonly y?: number;
  readonly isFitting?: boolean;
  readonly fittingK?: number; // minor-loss K for straight-through / fixed-turn fittings (h = K·v²/2g)
  readonly fittingKBranch?: number; // higher K used when flow turns off to a branch (tee/cross)
}
export interface PressureEdgeInput {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  readonly headlossM: number; // Hazen–Williams friction head for this segment [m]
  readonly velocityMps?: number; // full-bore velocity in this segment [m/s] (for fitting minor losses)
}

export interface NodePressure {
  readonly nodeId: string;
  readonly residualKPa: number;
  readonly frictionM: number; // cumulative head loss from source [m] (pipe friction + fitting minor)
  readonly minorM: number; // portion of frictionM from fitting minor losses [m]
  readonly staticGainM: number; // z_source − z_node [m] (positive = gravity assists)
  readonly parent: string | null;
  readonly parentPipe: string | null;
}
export interface FixturePressure {
  readonly id: string;
  readonly type: string;
  readonly residualKPa: number;
  readonly pass: boolean; // ≥ code minimum residual
  readonly over: boolean; // > code maximum (needs a PRV)
}
export interface PressureAnalysis {
  readonly hasSource: boolean;
  readonly supplyPressureKPa: number;
  readonly minResidualKPa: number;
  readonly maxPressureKPa: number;
  readonly nodes: ReadonlyMap<string, NodePressure>;
  readonly fixtures: readonly FixturePressure[];
  readonly worst: FixturePressure | null; // lowest-residual fixture (governs the design)
  readonly criticalPipeIds: readonly string[]; // source → worst fixture
  readonly criticalNodeIds: readonly string[];
  readonly totalFrictionM: number; // total head loss to the worst fixture [m] (pipe + fitting)
  readonly minorToCriticalM: number; // fitting (minor) portion of the loss to the worst fixture [m]
  readonly criticalFittings: number; // number of fittings on the critical path
  readonly allPass: boolean;
  readonly failing: number;
  readonly overpressure: number;
  readonly assumptions: readonly string[];
}

/** A concrete, applyable remedy when the pressure balance fails (plumbing spec §3 — design iteration). */
export interface PressureRemedy {
  readonly needed: boolean;
  readonly under: boolean; // one or more outlets below the code minimum
  readonly over: boolean; // one or more outlets above the code maximum
  /** Smallest source pressure (rounded up to 10 kPa) that clears every under-pressure outlet. */
  readonly raiseSupplyToKPa: number | null;
  /** True if that supply raise would push an outlet over the maximum (⇒ prefer the upsize instead). */
  readonly raiseCausesOverpressure: boolean;
  /** Per-pipe diameter increases on the critical path that clear the shortfall at the CURRENT supply. */
  readonly upsize: readonly { readonly pipeId: string; readonly fromOd: number; readonly toOd: number }[];
  readonly upsizeAchievesPass: boolean;
  /** Over-pressure cannot be fixed by supply/size — it needs a pressure-reducing valve. */
  readonly prvNeeded: boolean;
  readonly overByKPa: number;
}

const ASSUMPTIONS: readonly string[] = [
  'Segment flow = simultaneous (Hunter) demand of its downstream fixtures.',
  'Hazen–Williams pipe friction + fitting minor losses (K·v²/2g); at a tee the turn angle picks run vs branch K; velocity head excluded.',
  'Residual = supply pressure + static (elevation) head − total head loss.',
];

/** Turn angle [deg] the flow makes at `node`, entering from `prev` and leaving toward `next`. 0° = straight through. */
function turnAngleDeg(
  prev: { x?: number; y?: number }, node: { x?: number; y?: number }, next: { x?: number; y?: number },
): number | null {
  if (prev.x == null || prev.y == null || node.x == null || node.y == null || next.x == null || next.y == null) return null;
  const ix = node.x - prev.x, iy = node.y - prev.y, ox = next.x - node.x, oy = next.y - node.y;
  const li = Math.hypot(ix, iy), lo = Math.hypot(ox, oy);
  if (li === 0 || lo === 0) return null;
  const cos = Math.max(-1, Math.min(1, (ix * ox + iy * oy) / (li * lo)));
  return (Math.acos(cos) * 180) / Math.PI;
}

/**
 * Solve residual pressure at every node of a supply tree rooted at `sourceId`. Pure and deterministic:
 * identical inputs → identical output. Nodes unreachable from the source are simply omitted (an
 * orphaned fixture has no supply path, which the caller surfaces separately).
 */
export function solveNetworkPressure(args: {
  readonly sourceId: string | null;
  readonly supplyPressureKPa: number;
  readonly minResidualKPa: number;
  readonly maxPressureKPa: number;
  readonly nodes: readonly PressureNodeInput[];
  readonly edges: readonly PressureEdgeInput[];
}): PressureAnalysis {
  const { sourceId, supplyPressureKPa, minResidualKPa, maxPressureKPa } = args;
  const nodeById = new Map(args.nodes.map((n) => [n.id, n]));

  const G = 9.80665; // gravitational acceleration [m/s²] for K·v²/2g
  const empty = (): PressureAnalysis => ({
    hasSource: false, supplyPressureKPa, minResidualKPa, maxPressureKPa,
    nodes: new Map(), fixtures: [], worst: null, criticalPipeIds: [], criticalNodeIds: [],
    totalFrictionM: 0, minorToCriticalM: 0, criticalFittings: 0, allPass: true, failing: 0, overpressure: 0, assumptions: ASSUMPTIONS,
  });
  if (!sourceId || !nodeById.has(sourceId)) return empty();

  // Undirected adjacency over supply edges; the BFS from the source orients it into a tree.
  const adj = new Map<string, { other: string; pipeId: string; headlossM: number; velocityMps: number }[]>();
  const touch = (n: string) => { if (!adj.has(n)) adj.set(n, []); };
  touch(sourceId);
  for (const e of args.edges) {
    if (!nodeById.has(e.from) || !nodeById.has(e.to)) continue;
    touch(e.from); touch(e.to);
    const h = Number.isFinite(e.headlossM) ? Math.max(0, e.headlossM) : 0;
    const vel = Number.isFinite(e.velocityMps) ? Math.max(0, e.velocityMps!) : 0;
    adj.get(e.from)!.push({ other: e.to, pipeId: e.id, headlossM: h, velocityMps: vel });
    adj.get(e.to)!.push({ other: e.from, pipeId: e.id, headlossM: h, velocityMps: vel });
  }

  const zSource = nodeById.get(sourceId)!.z;
  const parent = new Map<string, string | null>([[sourceId, null]]);
  const parentPipe = new Map<string, string | null>([[sourceId, null]]);
  const friction = new Map<string, number>([[sourceId, 0]]);
  const minor = new Map<string, number>([[sourceId, 0]]);
  const out = new Map<string, NodePressure>();
  const record = (id: string, fr: number, mn: number, pp: string | null, par: string | null) => {
    const z = nodeById.get(id)!.z;
    const residualKPa = supplyPressureKPa + RHO_G_KPA_PER_M * (zSource - z) - RHO_G_KPA_PER_M * fr;
    out.set(id, { nodeId: id, residualKPa, frictionM: fr, minorM: mn, staticGainM: zSource - z, parent: par, parentPipe: pp });
  };
  record(sourceId, 0, 0, null, null);

  const visited = new Set<string>([sourceId]);
  const queue: string[] = [sourceId];
  while (queue.length) {
    const u = queue.shift()!;
    const uNode = nodeById.get(u)!;
    const uParent = parent.get(u) ?? null;
    for (const nb of adj.get(u) ?? []) {
      if (visited.has(nb.other)) continue;
      visited.add(nb.other);
      parent.set(nb.other, u);
      parentPipe.set(nb.other, nb.pipeId);
      const child = nodeById.get(nb.other)!;
      // Minor loss is incurred LEAVING a fitting u toward this child, referenced to the outgoing
      // pipe velocity. For a tee/cross the turn angle (inlet→u→child) selects branch vs run K.
      let minorLoss = 0;
      if (uNode.isFitting && Number.isFinite(uNode.fittingK)) {
        let k = Math.max(0, uNode.fittingK!);
        if (uParent != null && Number.isFinite(uNode.fittingKBranch)) {
          const turn = turnAngleDeg(nodeById.get(uParent)!, uNode, child);
          if (turn != null && turn >= 45) k = Math.max(0, uNode.fittingKBranch!); // ≥45° ⇒ branch takeoff
        }
        minorLoss = (k * nb.velocityMps * nb.velocityMps) / (2 * G);
      }
      const fr = (friction.get(u) ?? 0) + nb.headlossM + minorLoss;
      const mn = (minor.get(u) ?? 0) + minorLoss;
      friction.set(nb.other, fr);
      minor.set(nb.other, mn);
      record(nb.other, fr, mn, nb.pipeId, u);
      queue.push(nb.other);
    }
  }

  const fixtures: FixturePressure[] = [];
  for (const n of args.nodes) {
    if (!n.isFixture) continue;
    const np = out.get(n.id);
    if (!np) continue; // not connected to the source — reported as orphaned elsewhere
    fixtures.push({
      id: n.id, type: n.type ?? 'fixture', residualKPa: np.residualKPa,
      pass: np.residualKPa >= minResidualKPa, over: np.residualKPa > maxPressureKPa,
    });
  }

  let worst: FixturePressure | null = null;
  for (const f of fixtures) if (!worst || f.residualKPa < worst.residualKPa) worst = f;

  const criticalNodeIds: string[] = [];
  const criticalPipeIds: string[] = [];
  if (worst) {
    let cur: string | null = worst.id;
    while (cur) {
      criticalNodeIds.push(cur);
      const pp = parentPipe.get(cur) ?? null;
      if (pp) criticalPipeIds.push(pp);
      cur = parent.get(cur) ?? null;
    }
    criticalNodeIds.reverse();
    criticalPipeIds.reverse();
  }

  const failing = fixtures.reduce((a, f) => a + (f.pass ? 0 : 1), 0);
  const overpressure = fixtures.reduce((a, f) => a + (f.over ? 1 : 0), 0);
  const criticalFittings = criticalNodeIds.reduce((a, id) => a + (nodeById.get(id)?.isFitting ? 1 : 0), 0);
  return {
    hasSource: true, supplyPressureKPa, minResidualKPa, maxPressureKPa,
    nodes: out, fixtures, worst, criticalPipeIds, criticalNodeIds,
    totalFrictionM: worst ? (friction.get(worst.id) ?? 0) : 0,
    minorToCriticalM: worst ? (minor.get(worst.id) ?? 0) : 0,
    criticalFittings,
    allPass: failing === 0 && overpressure === 0, failing, overpressure, assumptions: ASSUMPTIONS,
  };
}
