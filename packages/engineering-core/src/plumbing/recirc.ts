import { hazenWilliamsHeadloss, pprInnerDiameter, velocity } from './hydraulics.ts';
import { qty, lps, mm, meter, mps } from '../units/index.ts';

/**
 * Hot-water RECIRCULATION analysis (plumbing spec §3 — hot-water systems). A recirculation system keeps
 * hot water moving in a closed loop (heater → supply run → far point → return → heater) so any outlet
 * gets hot water quickly. Hydraulically that loop is a CYCLE in the hot piping, not a tree — so unlike
 * the supply pressure solve (a tree), here we find the cycle and size the pump that drives it.
 *
 * The recirculation flow is small and set by heat-loss make-up (not fixture demand), so it is an engineer
 * input. Given it, the required pump head is simply the Hazen–Williams friction all the way around the
 * loop at that flow — computed from the real drawn pipe sizes and lengths. No invented numbers.
 */

export const RHO_G_KPA_PER_M = 9.80665;

export interface RecircEdgeInput {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  readonly odMm: number; // sized outer diameter of this hot pipe
  readonly lengthM: number;
  readonly sdr: number;
}

/** One recirculation branch (a fundamental loop closed by a return leg) and its balancing requirement. */
export interface RecircBranch {
  readonly returnPipeId: string; // the loop-closing (return) pipe
  readonly loopPipeIds: readonly string[];
  readonly loopLengthM: number;
  readonly flowLps: number; // this branch's share of the recirc flow (heat-loss / length proxy)
  readonly frictionM: number; // loop friction at flowLps [m]
  readonly returnVelocityMps: number;
  readonly isIndex: boolean; // the governing (highest-friction) branch — its balancing valve stays fully open
  readonly balanceHeadM: number; // head the branch's balancing valve must dissipate to match the index [m]
  readonly balanceValveKv: number | null; // balancing-valve flow coefficient Kv [m³/h] for that head (null for the index)
}

export interface RecircAnalysis {
  readonly active: boolean; // a closed hot loop exists
  readonly recircFlowLps: number;
  readonly branches: readonly RecircBranch[]; // one per return leg
  // Index-branch (governing) summary — also the single-loop values:
  readonly loopPipeIds: readonly string[];
  readonly returnPipeId: string | null;
  readonly loopLengthM: number;
  readonly frictionM: number; // head loss around the governing loop at its flow [m]
  readonly pumpHeadKPa: number; // required recirculation pump head (governing branch)
  readonly returnVelocityMps: number | null;
  readonly assumptions: readonly string[];
}

const ASSUMPTIONS: readonly string[] = [
  'Recirculation flow is an engineer input (heat-loss make-up), split across branches by loop length.',
  'Pump head = Hazen–Williams friction around the governing (index) loop at its flow, using drawn sizes/lengths.',
  'Balancing valve head = index-loop friction − branch friction (proportional balancing, first pass).',
  'Minor (fitting) losses and iterative flow re-balancing across shared trunks are excluded.',
];

const inactive = (recircFlowLps: number): RecircAnalysis => ({
  active: false, recircFlowLps, branches: [], loopPipeIds: [], returnPipeId: null, loopLengthM: 0,
  frictionM: 0, pumpHeadKPa: 0, returnVelocityMps: null, assumptions: ASSUMPTIONS,
});

/**
 * Find the governing hot recirculation loop (the fundamental cycle with the greatest friction) and the
 * pump head to drive `recircFlowLps` around it. Pure and deterministic. Returns `active:false` when the
 * hot piping is a tree (no return leg drawn).
 */
export function analyzeRecirc(args: {
  readonly sourceId: string | null;
  readonly recircFlowLps: number;
  readonly hazenWilliamsC: number;
  readonly edges: readonly RecircEdgeInput[];
}): RecircAnalysis {
  const { sourceId, recircFlowLps, hazenWilliamsC } = args;
  if (!sourceId || args.edges.length === 0) return inactive(recircFlowLps);

  const edgeById = new Map(args.edges.map((e) => [e.id, e]));
  const adj = new Map<string, { other: string; edgeId: string }[]>();
  const touch = (n: string) => { if (!adj.has(n)) adj.set(n, []); };
  touch(sourceId);
  for (const e of args.edges) { touch(e.from); touch(e.to); adj.get(e.from)!.push({ other: e.to, edgeId: e.id }); adj.get(e.to)!.push({ other: e.from, edgeId: e.id }); }

  // BFS spanning tree from the source; remember the edge that reached each node.
  const parent = new Map<string, { parent: string | null; edgeId: string | null }>([[sourceId, { parent: null, edgeId: null }]]);
  const visited = new Set<string>([sourceId]);
  const queue: string[] = [sourceId];
  while (queue.length) {
    const u = queue.shift()!;
    for (const nb of adj.get(u) ?? []) {
      if (visited.has(nb.other)) continue;
      visited.add(nb.other);
      parent.set(nb.other, { parent: u, edgeId: nb.edgeId });
      queue.push(nb.other);
    }
  }

  // Non-tree edges between two reached nodes close a loop (the return legs) → one recirculation branch each.
  const treeEdgeIds = new Set([...parent.values()].map((p) => p.edgeId).filter((x): x is string => x != null));
  const frictionOf = (e: RecircEdgeInput, flowLps: number): number =>
    hazenWilliamsHeadloss(qty(flowLps, lps), pprInnerDiameter(qty(e.odMm, mm), e.sdr), hazenWilliamsC, qty(e.lengthM, meter)).in(meter);

  const raw: { back: RecircEdgeInput; loop: string[]; length: number }[] = [];
  for (const e of args.edges) {
    if (treeEdgeIds.has(e.id)) continue;
    if (!visited.has(e.from) || !visited.has(e.to)) continue; // dangling, not a closed loop with the source
    const loop = fundamentalCycle(e, parent);
    if (!loop) continue;
    let length = 0;
    for (const pid of loop) length += edgeById.get(pid)?.lengthM ?? 0;
    raw.push({ back: e, loop, length });
  }
  if (raw.length === 0) return inactive(recircFlowLps);

  // Split the total recirc flow across branches by loop length (heat-loss ∝ pipe surface, first pass).
  const totalLen = raw.reduce((s, r) => s + r.length, 0);
  const withFlow = raw.map((r) => {
    const flowLps = totalLen > 0 ? recircFlowLps * (r.length / totalLen) : recircFlowLps / raw.length;
    let friction = 0;
    for (const pid of r.loop) { const pe = edgeById.get(pid); if (pe) friction += frictionOf(pe, flowLps); }
    const returnVelocityMps = velocity(qty(flowLps, lps), pprInnerDiameter(qty(r.back.odMm, mm), r.back.sdr)).in(mps);
    return { ...r, flowLps, friction, returnVelocityMps };
  });

  const indexFriction = Math.max(...withFlow.map((b) => b.friction));
  const branches: RecircBranch[] = withFlow.map((b) => {
    const isIndex = b.friction === indexFriction;
    const balanceHeadM = Math.max(0, indexFriction - b.friction);
    // Kv [m³/h] = Q[m³/h] / √(Δp[bar]); Δp[bar] = head[m] × 0.0980665
    const balanceValveKv = !isIndex && balanceHeadM > 1e-9 ? (b.flowLps * 3.6) / Math.sqrt(balanceHeadM * 0.0980665) : null;
    return {
      returnPipeId: b.back.id, loopPipeIds: b.loop, loopLengthM: b.length, flowLps: b.flowLps,
      frictionM: b.friction, returnVelocityMps: b.returnVelocityMps, isIndex, balanceHeadM, balanceValveKv,
    };
  });
  const index = branches.find((b) => b.isIndex)!;
  return {
    active: true, recircFlowLps, branches,
    loopPipeIds: index.loopPipeIds, returnPipeId: index.returnPipeId, loopLengthM: index.loopLengthM,
    frictionM: index.frictionM, pumpHeadKPa: index.frictionM * RHO_G_KPA_PER_M, returnVelocityMps: index.returnVelocityMps,
    assumptions: ASSUMPTIONS,
  };
}

/** The fundamental cycle a back-edge closes: tree path between its endpoints (up to their LCA) + the edge. */
function fundamentalCycle(back: RecircEdgeInput, parent: Map<string, { parent: string | null; edgeId: string | null }>): string[] | null {
  const depthOf = new Map<string, number>();
  let cur: string | null = back.from, d = 0;
  while (cur != null) { depthOf.set(cur, d++); cur = parent.get(cur)?.parent ?? null; }
  let lca: string | null = back.to;
  while (lca != null && !depthOf.has(lca)) lca = parent.get(lca)?.parent ?? null;
  if (lca == null) return null;

  const loop = new Set<string>([back.id]);
  for (let x: string | null = back.from; x !== lca && x != null; ) { const pe = parent.get(x); if (!pe || pe.edgeId == null) break; loop.add(pe.edgeId); x = pe.parent; }
  for (let y: string | null = back.to; y !== lca && y != null; ) { const pe = parent.get(y); if (!pe || pe.edgeId == null) break; loop.add(pe.edgeId); y = pe.parent; }
  return [...loop];
}
