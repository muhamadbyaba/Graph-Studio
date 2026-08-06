import { Source, Derived, source, derived } from '../core/reactive.ts';
import { hunterDemand } from '../plumbing/demand.ts';
import { sizeSupplyPipeRule } from '../plumbing/sizing.ts';
import { velocityCheckRule } from '../plumbing/rules.ts';
import { hazenWilliamsHeadloss, pprInnerDiameter, velocity } from '../plumbing/hydraulics.ts';
import { solveNetworkPressure } from '../plumbing/pressure.ts';
import type { PressureAnalysis, PressureNodeInput, PressureEdgeInput, PressureRemedy } from '../plumbing/pressure.ts';
import { analyzeRecirc } from '../plumbing/recirc.ts';
import type { RecircAnalysis } from '../plumbing/recirc.ts';
import { analyzeDwv } from '../plumbing/dwv.ts';
import type { DwvAnalysis } from '../plumbing/dwv.ts';
import { sizeDrainRule, drainSlopeRule, drainVelocityRule, sizeVentRule, stackBranchRule } from '../plumbing/drainage.ts';
import { sizeCableRule } from '../electrical/sizing.ts';
import { voltageDropCheckRule } from '../electrical/rules.ts';
import { sizeDuctRule, ductVelocityRule } from '../hvac/ducts.ts';
import { sizeBeamRule } from '../structural/beams.ts';
import { sizeColumnRule } from '../structural/columns.ts';
import { sizeSlabRule } from '../structural/slabs.ts';
import { qty, lps, mm, meter, ampere, mps } from '../units/index.ts';
import { aggregate, round, groupOf } from '../boq/boq.ts';
import { defaultRate } from '../boq/costbook.ts';
import type { BoqLine } from '../boq/boq.ts';
import type { JurisdictionPack } from '../jurisdiction/types.ts';
import type { RuleContext, RuleResult } from '../rules/rule.ts';

/**
 * Multi-discipline geometric layout (Doc 02 §3.1, Doc 08 reuse). Four independent systems on the
 * same canvas, each a tree rooted at its own source:
 *   supply (cold/hot) → water tank · drainage → sewer outlet · vent → roof terminal · power → panel.
 * Nodes carry (x, y) + z elevation and a per-discipline load (WSFU/DFU for plumbing, amps for
 * electrical). Every size/validation comes from the shared, pure engineering rules.
 */

export type Medium = 'cold' | 'hot' | 'drainage' | 'vent' | 'power' | 'air' | 'beam';
export type LayoutNodeKind = 'source' | 'outlet' | 'vent-terminal' | 'panel' | 'ahu' | 'support' | 'fixture' | 'load' | 'diffuser' | 'junction' | 'fitting';
type System = 'supply' | 'drainage' | 'vent' | 'power' | 'air' | 'structure';

const FITTING_LABELS: Record<string, string> = { elbow90: 'Elbow 90°', elbow45: 'Elbow 45°', tee: 'Tee', cross: 'Cross', coupling: 'Coupling', reducer: 'Reducer', union: 'Union', endcap: 'End Cap', transition: 'Transition (brass)', valve: 'Valve' };
const COLUMN_RATE_PER_M3 = 650; // composite RC column rate $/m³ (concrete+rebar+formwork) [VERIFY]
const SLAB_RATE_PER_M3 = 480; // composite RC slab rate $/m³ (concrete+rebar+formwork) [VERIFY]
const isSupplyMedium = (m: Medium): boolean => m === 'cold' || m === 'hot';
const systemOf = (m: Medium): System => (m === 'drainage' ? 'drainage' : m === 'vent' ? 'vent' : m === 'power' ? 'power' : m === 'air' ? 'air' : m === 'beam' ? 'structure' : 'supply');

/**
 * Guard the model boundary against values that would silently poison the whole graph.
 *
 * A single NaN or Infinity entering a coordinate propagates through every length, demand, head loss
 * and cost derived from it, and `JSON.stringify` turns it into `null` on the way out — so the
 * failure surfaces far from its cause. Rejecting it here keeps the invariant "every number in the
 * model is finite" true everywhere downstream.
 */
function finite(value: number, what: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${what} must be a finite number (got ${String(value)})`);
  return value;
}

function defaultZ(kind: LayoutNodeKind): number {
  switch (kind) {
    case 'fixture': return 0.5;
    case 'load': return 1.2;
    case 'source': return 1.0;
    case 'panel': return 1.5;
    case 'outlet': return 0.1;
    case 'vent-terminal': return 3.0;
    case 'ahu': return 2.8;
    case 'diffuser': return 2.6;
    case 'support': return 0.2;
    case 'fitting': return 1.0;
    default: return 2.4;
  }
}

export interface PipeProduct {
  readonly name: string;
  readonly material: string;
  readonly odMm: number;
  readonly pn?: number;
  readonly price?: number;
}

/** A routing bend point (elbow) between a pipe's two end nodes — lets a run turn instead of going straight. */
export interface Waypoint { readonly x: number; readonly y: number; }

export interface LayoutNode {
  readonly id: string;
  readonly kind: LayoutNodeKind;
  readonly x: Source<number>;
  readonly y: Source<number>;
  readonly z: Source<number>;
  readonly rotationDeg: Source<number>; // plan rotation of the component symbol [degrees]
  readonly fixtureType?: Source<string>;
  readonly wsfu?: Derived<number>;
  readonly dfu?: Derived<number>;
  readonly loadA?: Source<number>; // electrical loads: design current [A]
  readonly airflowLps?: Source<number>; // HVAC diffusers: airflow [L/s]
  readonly axialOverrideKn?: Source<number | null>; // engineer override of the PER-FLOOR axial load [kN] (null = auto)
  readonly floorsSupported?: Source<number>; // number of typical floors this column carries (multi-storey stacking)
  readonly derivedAxialKn?: Derived<number>; // per-floor axial from framing beam reactions [kN]
  readonly perFloorAxialKn?: Derived<number>; // per-floor design load = override ?? from-beams
  readonly effectiveAxialKn?: Derived<number>; // total design load = per-floor × floorsSupported
  readonly columnSizing?: Derived<RuleResult>; // the sized RC column for a support node
}

export interface LayoutPipe {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  readonly medium: Medium;
  readonly lengthM: Derived<number>;
  readonly cumulativeWsfu: Derived<number>;
  readonly cumulativeDfu: Derived<number>;
  readonly cumulativeAmps: Derived<number>;
  readonly cumulativeAirLps: Derived<number>;
  readonly demandLps: Derived<number>;
  readonly sizing: Derived<RuleResult>;
  readonly velocity: Derived<RuleResult>;
  readonly headlossM: Derived<number>;
  readonly slopePct: Source<number> | null;
  readonly slopeCheck: Derived<RuleResult> | null;
  readonly isStack: Derived<boolean>; // drainage: vertical stack vs horizontal branch/drain
  readonly isOffset: Derived<boolean>; // drainage: a stack offset (jogs both horizontally and vertically)
  readonly stackFloors: Source<number> | null; // drainage stack: branch intervals (floors) it repeats over
  readonly perIntervalDfu: Derived<number>; // DFU at one branch interval (per floor)
  readonly stackBranchCheck: Derived<RuleResult> | null; // drainage: DFU-per-branch-interval vs stack-size limit
  readonly manualOd: Source<number | null>;
  readonly product: Source<PipeProduct | null>;
  readonly beamLoad: Source<number> | null; // structural beams: uniform load [kN/m]
  readonly waypoints: Source<readonly Waypoint[]>; // routing bends (elbows) between from and to
}

export interface Slab {
  readonly id: string;
  readonly corners: readonly string[]; // ordered node ids forming the panel polygon
  readonly loadKnPerM2: Source<number>; // applied (superimposed) factored load
  readonly areaM2: Derived<number>;
  readonly sizing: Derived<RuleResult>; // slab thickness + steel design
}

/** Slope / self-cleansing checks don't apply to a vertical stack — report N/A (passing). */
function stackNaResult(): RuleResult {
  return {
    value: null, pass: true,
    trace: { formula: 'vertical stack — horizontal slope & Manning self-cleansing not applicable', inputs: { kind: 'vertical stack' }, steps: [{ expr: 'stack', result: 'gravity vertical — no slope/velocity check' }], clause: 'Vertical stack', assumptions: ['Flow is vertical; horizontal grade & self-cleansing velocity do not apply'] },
  };
}

function manualSizeResult(od: number): RuleResult {
  return {
    value: od, pass: true,
    trace: { formula: 'manual size override (engineer-selected)', inputs: { size: `${od}` }, steps: [{ expr: 'override', result: `${od} selected manually` }], clause: 'Manual override — validation still applies', assumptions: ['Size locked by the user'] },
  };
}

interface Topology { readonly downstreamFixturesByPipe: Map<string, string[]>; }

export class PlumbingLayout {
  private readonly pack: JurisdictionPack;
  private readonly ctx: RuleContext;
  private sourceId: string | null = null;
  private outletId: string | null = null;
  private ventRootId: string | null = null;
  private panelId: string | null = null;
  private ahuId: string | null = null;
  private readonly topoVersion: Source<number> = source(0);
  private readonly topology: Derived<Topology>;

  readonly nodes = new Map<string, LayoutNode>();
  readonly pipes = new Map<string, LayoutPipe>();
  readonly slabs = new Map<string, Slab>();
  readonly boq: Derived<BoqLine[]>;
  /** Available supply pressure at the source connection [kPa] — a project parameter (municipal + booster,
   * or tank head at the source elevation). Drives the network pressure balance below. */
  readonly supplyPressureKPa: Source<number> = source(300);
  /** Live hydraulic network analysis: residual pressure at every supply node + the critical fixture. */
  readonly pressure: Derived<PressureAnalysis>;
  /** Design recirculation flow for the hot loop [L/s] — heat-loss make-up, an engineer input. */
  readonly recircFlowLps: Source<number> = source(0.1);
  /** Hot-water recirculation loop analysis: required pump head to drive the loop. */
  readonly recirc: Derived<RecircAnalysis>;
  /** Drainage–waste–vent network validation: every fixture reaches the sewer, every trap is vented. */
  readonly dwv: Derived<DwvAnalysis>;
  /** Per-drainage-pipe effective DFU, accounting for stacks that repeat over N floors (branch intervals). */
  readonly drainageDfu: Derived<Map<string, { perFloor: number; total: number }>>;

  constructor(pack: JurisdictionPack) {
    this.pack = pack;
    this.ctx = { jurisdiction: pack };
    this.topology = derived(() => {
      this.topoVersion.get();
      return computeTopology(this.nodes, this.pipes, { supply: this.sourceId, drainage: this.outletId, vent: this.ventRootId, power: this.panelId, air: this.ahuId, structure: null });
    });
    this.boq = derived(() => {
      this.topoVersion.get();
      const lines: BoqLine[] = [];
      for (const p of this.pipes.values()) {
        const size = p.sizing.get().value as number | null;
        if (size === null) continue;
        const qtyM = round(p.lengthM.get() * 1.05, 2);
        const prod = p.product.get();
        if (prod) { lines.push({ itemCode: `PROD-${prod.name}`, description: `${prod.name} (${prod.material})`, unit: 'm', qty: qtyM, rate: prod.price }); continue; }
        if (isSupplyMedium(p.medium)) {
          const pn = this.pack.supply.pprCatalog.find((s) => s.odMm === size)?.pn ?? 0;
          lines.push({ itemCode: `PPR-OD${size}-PN${pn}-${p.medium}`, description: `PPR pipe Ø${size} PN${pn} (${p.medium})`, unit: 'm', qty: qtyM });
        } else if (p.medium === 'vent') {
          lines.push({ itemCode: `VENT-OD${size}`, description: `uPVC vent Ø${size}mm`, unit: 'm', qty: qtyM });
        } else if (p.medium === 'power') {
          lines.push({ itemCode: `CABLE-${size}`, description: `Cu cable ${size} mm²`, unit: 'm', qty: qtyM });
        } else if (p.medium === 'air') {
          lines.push({ itemCode: `DUCT-${size}`, description: `GI round duct Ø${size}mm`, unit: 'm', qty: qtyM });
        } else if (p.medium === 'beam') {
          lines.push({ itemCode: `BEAM-${size}`, description: `RC beam ${size}mm deep`, unit: 'm', qty: qtyM });
        } else {
          lines.push({ itemCode: `DRAIN-OD${size}`, description: `uPVC drain Ø${size}mm`, unit: 'm', qty: qtyM });
        }
      }
      for (const n of this.nodes.values()) {
        if (n.kind === 'fixture' && n.fixtureType) { const t = n.fixtureType.get(); lines.push({ itemCode: `FIX-${t}`, description: t.replace(/([a-z])([A-Z])/g, '$1 $2'), unit: 'nr', qty: 1 }); }
        if (n.kind === 'load') lines.push({ itemCode: 'ELEC-load', description: 'Electrical point (outlet/light)', unit: 'nr', qty: 1 });
        if (n.kind === 'diffuser') lines.push({ itemCode: 'HVAC-diffuser', description: 'Air diffuser / grille', unit: 'nr', qty: 1 });
        if (n.kind === 'fitting' && n.fixtureType) { const raw = n.fixtureType.get(); const [t, od] = raw.split('|'); const label = FITTING_LABELS[t] ?? t; lines.push({ itemCode: `FIT-${raw}`, description: od ? `PPR ${label} Ø${od}mm` : `PPR ${label}`, unit: 'nr', qty: 1 }); }
        if (n.kind === 'support' && n.columnSizing) {
          const b = n.columnSizing.get().value as number | null;
          if (b !== null) {
            const storeyM = 3.0; // assumed storey height for concrete take-off [VERIFY]
            const concM3 = (b / 1000) * (b / 1000) * storeyM;
            const rate = round(concM3 * COLUMN_RATE_PER_M3, 2); // composite $/column (concrete+rebar+formwork)
            lines.push({ itemCode: `COL-${b}`, description: `RC column ${b}×${b} mm (${storeyM} m)`, unit: 'nr', qty: 1, rate });
          }
        }
      }
      for (const sl of this.slabs.values()) {
        const h = sl.sizing.get().value as number | null;
        if (h === null) continue;
        const volM3 = round(sl.areaM2.get() * (h / 1000), 2); // concrete volume [m³]
        lines.push({ itemCode: `SLAB-${h}`, description: `RC slab ${h} mm`, unit: 'm³', qty: volM3, rate: SLAB_RATE_PER_M3 });
      }
      return aggregate(lines.map((l) => ({ ...l, rate: l.rate ?? defaultRate(l.itemCode), group: groupOf(l.itemCode) })));
    });

    this.pressure = derived(() => {
      this.topoVersion.get(); // react to nodes/pipes/source being added or removed
      return solveNetworkPressure({
        sourceId: this.sourceId,
        supplyPressureKPa: this.supplyPressureKPa.get(),
        minResidualKPa: this.pack.supply.minResidualKPa,
        maxPressureKPa: this.pack.supply.maxPressureKPa,
        nodes: this.pressureNodeInputs(),
        edges: this.supplyEdgeInputs(),
      });
    });

    this.recirc = derived(() => {
      this.topoVersion.get();
      const sdrOf = (od: number) => this.pack.supply.pprCatalog.find((s) => s.odMm === od)?.sdr ?? 6;
      const edges = [...this.pipes.values()]
        .filter((p) => p.medium === 'hot')
        .map((p) => ({ id: p.id, from: p.from, to: p.to, odMm: (p.sizing.get().value as number | null) ?? 20, lengthM: p.lengthM.get(), sdr: sdrOf((p.sizing.get().value as number | null) ?? 20) }));
      return analyzeRecirc({ sourceId: this.sourceId, recircFlowLps: this.recircFlowLps.get(), hazenWilliamsC: this.pack.supply.hazenWilliamsC_PPR, edges });
    });

    this.dwv = derived(() => {
      this.topoVersion.get();
      const fixtures = [...this.nodes.values()].filter((n) => n.kind === 'fixture').map((n) => ({ id: n.id, type: n.fixtureType?.get(), dfu: n.dfu?.get() ?? 0 }));
      const drainEdges = [...this.pipes.values()].filter((p) => p.medium === 'drainage').map((p) => ({ id: p.id, from: p.from, to: p.to }));
      const ventEdges = [...this.pipes.values()].filter((p) => p.medium === 'vent').map((p) => ({ id: p.id, from: p.from, to: p.to }));
      return analyzeDwv({ outletId: this.outletId, ventRootId: this.ventRootId, fixtures, drainEdges, ventEdges });
    });

    this.drainageDfu = derived(() => {
      this.topoVersion.get();
      const result = new Map<string, { perFloor: number; total: number }>();
      const outlet = this.outletId;
      if (!outlet || !this.nodes.has(outlet)) return result;
      const drainPipes = [...this.pipes.values()].filter((p) => p.medium === 'drainage');
      const adj = new Map<string, { other: string; pipe: LayoutPipe }[]>();
      const touch = (n: string) => { if (!adj.has(n)) adj.set(n, []); };
      touch(outlet);
      for (const p of drainPipes) { touch(p.from); touch(p.to); adj.get(p.from)!.push({ other: p.to, pipe: p }); adj.get(p.to)!.push({ other: p.from, pipe: p }); }
      // BFS spanning tree from the outlet
      const parentPipe = new Map<string, LayoutPipe>();
      const order: string[] = [];
      const visited = new Set<string>([outlet]);
      const queue: string[] = [outlet];
      const children = new Map<string, string[]>();
      while (queue.length) {
        const u = queue.shift()!;
        order.push(u);
        for (const nb of adj.get(u) ?? []) {
          if (visited.has(nb.other)) continue;
          visited.add(nb.other);
          parentPipe.set(nb.other, nb.pipe);
          (children.get(u) ?? children.set(u, []).get(u)!).push(nb.other);
          queue.push(nb.other);
        }
      }
      // Bottom-up: a stack edge repeats its subtree over N floors (branch intervals).
      const subtree = new Map<string, number>();
      for (let i = order.length - 1; i >= 0; i--) {
        const node = order[i];
        let sum = this.nodes.get(node)?.dfu?.get() ?? 0; // own fixture DFU (0 for non-fixtures)
        for (const c of children.get(node) ?? []) {
          const pe = parentPipe.get(c)!;
          const floors = pe.isStack.get() && pe.stackFloors ? Math.max(1, pe.stackFloors.get()) : 1;
          const perFloor = subtree.get(c) ?? 0;
          const total = floors * perFloor;
          result.set(pe.id, { perFloor, total });
          sum += total;
        }
        subtree.set(node, sum);
      }
      return result;
    });
  }

  setSupplyPressure(kPa: number): this { this.supplyPressureKPa.set(Math.max(0, finite(kPa, 'supply pressure'))); return this; }
  setRecircFlow(lps: number): this { this.recircFlowLps.set(Math.max(0, finite(lps, 'recirculation flow'))); return this; }

  /** Node inputs for the pressure solver (reads live signals — call inside a derived to stay reactive). */
  private pressureNodeInputs(): PressureNodeInput[] {
    const fk = this.pack.supply.fittingK, fkb = this.pack.supply.fittingKBranch;
    return [...this.nodes.values()].map((n) => {
      const fitType = n.kind === 'fitting' ? (n.fixtureType?.get() ?? '').split('|')[0] : '';
      return {
        id: n.id, x: n.x.get(), y: n.y.get(), z: n.z.get(), isFixture: n.kind === 'fixture', type: n.fixtureType?.get(),
        isFitting: n.kind === 'fitting',
        fittingK: n.kind === 'fitting' ? (fk?.[fitType] ?? 0) : undefined,
        fittingKBranch: n.kind === 'fitting' ? fkb?.[fitType] : undefined,
      };
    });
  }

  /** Supply-edge inputs. `override` (pipeId→OD) recomputes head loss + velocity at trial sizes for the auto-fix. */
  private supplyEdgeInputs(override?: Map<string, number>): PressureEdgeInput[] {
    const C = this.pack.supply.hazenWilliamsC_PPR;
    const sdrOf = (od: number) => this.pack.supply.pprCatalog.find((s) => s.odMm === od)?.sdr ?? 6;
    return [...this.pipes.values()].filter((p) => isSupplyMedium(p.medium)).map((p) => {
      const od = override?.get(p.id);
      if (od != null) {
        const id = pprInnerDiameter(qty(od, mm), sdrOf(od));
        const flow = qty(p.demandLps.get(), lps);
        return { id: p.id, from: p.from, to: p.to, headlossM: hazenWilliamsHeadloss(flow, id, C, qty(p.lengthM.get(), meter)).in(meter), velocityMps: velocity(flow, id).in(mps) };
      }
      const vv = p.velocity.get().value as { in?: (u: unknown) => number } | number | null;
      const velocityMps = vv && typeof vv === 'object' && typeof vv.in === 'function' ? vv.in(mps) : 0;
      return { id: p.id, from: p.from, to: p.to, headlossM: p.headlossM.get(), velocityMps };
    });
  }

  /**
   * When the pressure balance fails, compute a concrete remedy: the exact supply pressure that clears
   * every under-pressure outlet, and/or a set of critical-path pipe upsizes that clear it at the current
   * supply (found by greedily upsizing the highest-payoff pipe and re-solving until it passes). Over-
   * pressure is reported as needing a PRV. Deterministic — no invented numbers.
   */
  pressureRemedy(): PressureRemedy {
    const pr = this.pressure.get();
    const none: PressureRemedy = { needed: false, under: false, over: false, raiseSupplyToKPa: null, raiseCausesOverpressure: false, upsize: [], upsizeAchievesPass: false, prvNeeded: false, overByKPa: 0 };
    if (!pr.hasSource || pr.fixtures.length === 0 || pr.allPass) return none;
    const under = pr.failing > 0, over = pr.overpressure > 0;
    const maxRes = Math.max(...pr.fixtures.map((f) => f.residualKPa));
    const supply = pr.supplyPressureKPa;

    let raiseSupplyToKPa: number | null = null, raiseCausesOverpressure = false;
    if (under && pr.worst) {
      const deficit = pr.minResidualKPa - pr.worst.residualKPa; // > 0
      raiseSupplyToKPa = Math.ceil((supply + deficit) / 10) * 10; // round up to 10 kPa (natural margin)
      if (maxRes + (raiseSupplyToKPa - supply) > pr.maxPressureKPa) raiseCausesOverpressure = true;
    }

    let upsize: { pipeId: string; fromOd: number; toOd: number }[] = [], upsizeAchievesPass = false;
    if (under) ({ upsize, upsizeAchievesPass } = this.computeUpsizePlan());

    return {
      needed: true, under, over, raiseSupplyToKPa, raiseCausesOverpressure,
      upsize, upsizeAchievesPass, prvNeeded: over, overByKPa: over ? Math.round((maxRes - pr.maxPressureKPa) * 10) / 10 : 0,
    };
  }

  /** Greedy diameter search: upsize the critical-path pipe with the biggest residual gain, re-solve, repeat. */
  private computeUpsizePlan(): { upsize: { pipeId: string; fromOd: number; toOd: number }[]; upsizeAchievesPass: boolean } {
    const catalog = this.pack.supply.pprCatalog.map((s) => s.odMm).slice().sort((a, b) => a - b);
    const chosen = new Map<string, number>();
    for (const p of this.pipes.values()) { if (!isSupplyMedium(p.medium)) continue; const od = p.sizing.get().value as number | null; if (od != null) chosen.set(p.id, od); }
    const start = new Map(chosen);
    const solve = () => solveNetworkPressure({ sourceId: this.sourceId, supplyPressureKPa: this.supplyPressureKPa.get(), minResidualKPa: this.pack.supply.minResidualKPa, maxPressureKPa: this.pack.supply.maxPressureKPa, nodes: this.pressureNodeInputs(), edges: this.supplyEdgeInputs(chosen) });

    let a = solve();
    let guard = 0;
    while (a.failing > 0 && guard++ < 200) {
      let best: { pid: string; next: number; gain: number } | null = null;
      for (const pid of a.criticalPipeIds) {
        const cur = chosen.get(pid); if (cur == null) continue;
        const idx = catalog.indexOf(cur);
        if (idx < 0 || idx >= catalog.length - 1) continue; // already largest
        const next = catalog[idx + 1];
        chosen.set(pid, next);
        const trial = solve();
        const gain = (trial.worst?.residualKPa ?? -1e9) - (a.worst?.residualKPa ?? -1e9);
        chosen.set(pid, cur); // revert trial
        if (!best || gain > best.gain) best = { pid, next, gain };
      }
      if (!best || best.gain <= 1e-9) break; // no size increase helps
      chosen.set(best.pid, best.next);
      a = solve();
    }
    const upsize: { pipeId: string; fromOd: number; toOd: number }[] = [];
    for (const [pid, od] of chosen) { const s = start.get(pid); if (s != null && od !== s) upsize.push({ pipeId: pid, fromOd: s, toOd: od }); }
    return { upsize, upsizeAchievesPass: a.failing === 0 };
  }

  private bump(): void { this.topoVersion.update((v) => v + 1); }

  addNode(id: string, kind: LayoutNodeKind, x: number, y: number, fixtureType?: string, z?: number): this {
    if (!id) throw new Error('addNode: an id is required');
    if (this.nodes.has(id)) throw new Error(`addNode: '${id}' already exists`);
    finite(x, `node '${id}' x`); finite(y, `node '${id}' y`);
    if (z !== undefined) finite(z, `node '${id}' z`);
    const xs = source(x), ys = source(y), zs = source(z ?? defaultZ(kind)), rot = source(0);
    let ft: Source<string> | undefined, wsfu: Derived<number> | undefined, dfu: Derived<number> | undefined, loadA: Source<number> | undefined, airflowLps: Source<number> | undefined;
    let axialOverrideKn: Source<number | null> | undefined, floorsSupported: Source<number> | undefined, derivedAxialKn: Derived<number> | undefined, perFloorAxialKn: Derived<number> | undefined, effectiveAxialKn: Derived<number> | undefined, columnSizing: Derived<RuleResult> | undefined;
    if (kind === 'fixture') {
      ft = source(fixtureType ?? 'Lavatory');
      const ref = ft;
      wsfu = derived(() => { const t = ref.get(); const w = this.pack.demand.wsfu[t]; if (w === undefined) throw new Error(`No WSFU value for fixture '${t}' in ${this.pack.id}`); return w; });
      dfu = derived(() => this.pack.drainage?.dfu[ref.get()] ?? 0);
    } else if (kind === 'load') {
      loadA = source(10); // default 10 A design current
    } else if (kind === 'diffuser') {
      airflowLps = source(50); // default 50 L/s
    } else if (kind === 'fitting') {
      ft = source(fixtureType ?? 'coupling'); // fittingType stored in the same field (elbow90/tee/…)
    } else if (kind === 'support') {
      const override = source<number | null>(null); // null = auto-derive from framing beams
      const floors = source(1); // typical floors carried by this column (multi-storey)
      const fromBeams = derived(() => {
        this.topoVersion.get(); // react to beams being added/removed
        let sum = 0;
        for (const p of this.pipes.values()) {
          if (p.medium !== 'beam' || !p.beamLoad) continue;
          if (p.from === id || p.to === id) sum += (p.beamLoad.get() * p.lengthM.get()) / 2; // simply-supported end reaction
        }
        return sum;
      });
      const perFloor = derived(() => override.get() ?? fromBeams.get());
      const effective = derived(() => perFloor.get() * Math.max(1, floors.get())); // stack N typical floors
      axialOverrideKn = override; floorsSupported = floors; derivedAxialKn = fromBeams; perFloorAxialKn = perFloor; effectiveAxialKn = effective;
      columnSizing = derived(() => sizeColumnRule.evaluate({ axialLoadKn: effective.get() }, this.ctx));
    }
    this.nodes.set(id, { id, kind, x: xs, y: ys, z: zs, rotationDeg: rot, fixtureType: ft, wsfu, dfu, loadA, airflowLps, axialOverrideKn, floorsSupported, derivedAxialKn, perFloorAxialKn, effectiveAxialKn, columnSizing });
    if (kind === 'source') this.sourceId = id;
    if (kind === 'outlet') this.outletId = id;
    if (kind === 'vent-terminal') this.ventRootId = id;
    if (kind === 'panel') this.panelId = id;
    if (kind === 'ahu') this.ahuId = id;
    this.bump();
    return this;
  }

  addPipe(id: string, from: string, to: string, medium: Medium, slopePct?: number, waypoints?: readonly Waypoint[]): this {
    if (!id) throw new Error('addPipe: an id is required');
    if (this.pipes.has(id)) throw new Error(`addPipe: '${id}' already exists`);
    if (from === to) throw new Error(`addPipe: '${id}' cannot connect '${from}' to itself`);
    if (!this.nodes.has(from)) throw new Error(`addPipe: '${id}' references unknown node '${from}'`);
    if (!this.nodes.has(to)) throw new Error(`addPipe: '${id}' references unknown node '${to}'`);
    if (slopePct !== undefined) finite(slopePct, `pipe '${id}' slope`);
    const wpts = source<readonly Waypoint[]>(waypoints ? waypoints.map((w, i) => ({ x: finite(w.x, `pipe '${id}' waypoint ${i} x`), y: finite(w.y, `pipe '${id}' waypoint ${i} y`) })) : []);
    const lengthM = derived(() => {
      const a = this.nodes.get(from), b = this.nodes.get(to);
      if (!a || !b) throw new Error(`Pipe '${id}' references missing node`);
      const pts = [{ x: a.x.get(), y: a.y.get() }, ...wpts.get(), { x: b.x.get(), y: b.y.get() }];
      let sum = 0;
      for (let i = 0; i < pts.length - 1; i++) sum += Math.hypot(pts[i + 1].x - pts[i].x, pts[i + 1].y - pts[i].y);
      return sum; // true routed length drives sizing, head loss, BOQ
    });
    const sys = systemOf(medium);
    const supply = sys === 'supply';
    const manualOd = source<number | null>(null);
    const product = source<PipeProduct | null>(null);
    const slope: Source<number> | null = sys === 'drainage' ? source(slopePct ?? 2) : null;
    const beamLoad: Source<number> | null = sys === 'structure' ? source(15) : null; // default 15 kN/m
    const downstream = () => this.topology.get().downstreamFixturesByPipe.get(id) ?? [];
    const stackFloors: Source<number> | null = sys === 'drainage' ? source(1) : null;
    // Drainage geometry: a near-vertical run is a STACK; a run with big horizontal AND vertical is an OFFSET.
    const dropRun = () => {
      const a = this.nodes.get(from), b = this.nodes.get(to);
      if (!a || !b) return { dz: 0, horiz: 0 };
      return { dz: Math.abs(a.z.get() - b.z.get()), horiz: lengthM.get() };
    };
    const isStack = derived(() => {
      if (sys !== 'drainage') return false;
      const { dz, horiz } = dropRun();
      return dz > Math.max(horiz, 0.3) && horiz < 0.6; // steeper than ~45° and little plan run
    });
    const isOffset = derived(() => {
      if (sys !== 'drainage') return false;
      const { dz, horiz } = dropRun();
      return dz > 0.6 && horiz >= 0.6; // jogs meaningfully in both directions
    });

    const cumulativeWsfu = derived(() => { if (sys !== 'supply') return 0; let s = 0; for (const t of downstream()) { const n = this.nodes.get(t); if (n?.wsfu) s += n.wsfu.get(); } return s; });
    const cumulativeDfu = derived(() => {
      if (sys === 'drainage') return this.drainageDfu.get().get(id)?.total ?? 0; // stack-multiplied
      if (sys === 'vent') { let s = 0; for (const t of downstream()) { const n = this.nodes.get(t); if (n?.dfu) s += n.dfu.get(); } return s; }
      return 0;
    });
    const perIntervalDfu = derived(() => (sys === 'drainage' ? (this.drainageDfu.get().get(id)?.perFloor ?? 0) : 0));
    const cumulativeAmps = derived(() => { if (sys !== 'power') return 0; let s = 0; for (const t of downstream()) { const n = this.nodes.get(t); if (n?.loadA) s += n.loadA.get(); } return s; });
    const cumulativeAirLps = derived(() => { if (sys !== 'air') return 0; let s = 0; for (const t of downstream()) { const n = this.nodes.get(t); if (n?.airflowLps) s += n.airflowLps.get(); } return s; });

    const demandLps = derived(() => (supply ? hunterDemand(cumulativeWsfu.get(), this.pack).in(lps) : 0));
    const autoSizing = derived(() => {
      if (sys === 'supply') return sizeSupplyPipeRule.evaluate({ flow: qty(demandLps.get(), lps), medium: medium as 'cold' | 'hot' }, this.ctx);
      if (sys === 'vent') return sizeVentRule.evaluate({ dfu: cumulativeDfu.get() }, this.ctx);
      if (sys === 'power') return sizeCableRule.evaluate({ designCurrent: qty(cumulativeAmps.get(), ampere), lengthOneWay: qty(lengthM.get(), meter) }, this.ctx);
      if (sys === 'air') return sizeDuctRule.evaluate({ airflow: qty(cumulativeAirLps.get(), lps) }, this.ctx);
      if (sys === 'structure') return sizeBeamRule.evaluate({ spanM: lengthM.get(), loadKnPerM: beamLoad!.get() }, this.ctx);
      return sizeDrainRule.evaluate({ dfu: cumulativeDfu.get(), isStack: isStack.get() }, this.ctx);
    });
    const sizing = derived(() => {
      const prod = product.get();
      const override = prod ? prod.odMm : manualOd.get();
      return override != null ? manualSizeResult(override) : autoSizing.get();
    });

    const slopeCheck = slope ? derived(() => isStack.get() ? stackNaResult() : drainSlopeRule.evaluate({ odMm: sizing.get().value as number, slopePct: slope.get() }, this.ctx)) : null;
    // Stacks additionally check DFU at one branch interval against the stack-size limit.
    const stackBranchCheck: Derived<RuleResult> | null = sys === 'drainage'
      ? derived(() => isStack.get() ? stackBranchRule.evaluate({ odMm: (sizing.get().value as number | null) ?? 0, perIntervalDfu: perIntervalDfu.get() }, this.ctx) : stackNaResult())
      : null;

    const velocity = derived(() => {
      const v = sizing.get().value as number | null;
      if (v === null) return sizing.get();
      if (sys === 'supply') {
        const sdr = this.pack.supply.pprCatalog.find((s) => s.odMm === v)?.sdr ?? 6;
        return velocityCheckRule.evaluate({ flow: qty(demandLps.get(), lps), innerDiameter: pprInnerDiameter(qty(v, mm), sdr), medium: medium as 'cold' | 'hot' }, this.ctx);
      }
      if (sys === 'drainage') return isStack.get() ? stackNaResult() : drainVelocityRule.evaluate({ odMm: v, slopePct: slope!.get() }, this.ctx);
      if (sys === 'power') {
        const cable = this.pack.electrical?.cableCatalog.find((c) => c.csaMm2 === v);
        if (!cable) return sizing.get();
        return voltageDropCheckRule.evaluate({ designCurrent: qty(cumulativeAmps.get(), ampere), lengthOneWay: qty(lengthM.get(), meter), resistanceOhmPerM: cable.resistanceOhmPerM }, this.ctx);
      }
      if (sys === 'air') return ductVelocityRule.evaluate({ airflow: qty(cumulativeAirLps.get(), lps), diameter: qty(v, mm) }, this.ctx);
      return sizing.get(); // vent has no flow criterion
    });

    const headlossM = derived(() => {
      if (!supply) return 0;
      const od = sizing.get().value as number | null;
      if (od === null) return 0;
      const sdr = this.pack.supply.pprCatalog.find((s) => s.odMm === od)?.sdr ?? 6;
      return hazenWilliamsHeadloss(qty(demandLps.get(), lps), pprInnerDiameter(qty(od, mm), sdr), this.pack.supply.hazenWilliamsC_PPR, qty(lengthM.get(), meter)).in(meter);
    });

    this.pipes.set(id, { id, from, to, medium, lengthM, cumulativeWsfu, cumulativeDfu, cumulativeAmps, cumulativeAirLps, demandLps, sizing, velocity, headlossM, slopePct: slope, slopeCheck, isStack, isOffset, stackFloors, perIntervalDfu, stackBranchCheck, manualOd, product, beamLoad, waypoints: wpts });
    this.bump();
    return this;
  }

  addSlab(id: string, corners: readonly string[], loadKnPerM2 = 5): this {
    if (!id) throw new Error('addSlab: an id is required');
    if (this.slabs.has(id)) throw new Error(`addSlab: '${id}' already exists`);
    if (corners.length < 3) throw new Error(`addSlab: '${id}' needs at least 3 corner nodes`);
    if (new Set(corners).size !== corners.length) throw new Error(`addSlab: '${id}' repeats a corner node`);
    for (const nid of corners) if (!this.nodes.has(nid)) throw new Error(`addSlab: '${id}' references unknown node '${nid}'`);
    finite(loadKnPerM2, `slab '${id}' load`);
    const cs = [...corners];
    const load = source(loadKnPerM2);
    const cornerPoints = (): { x: number; y: number }[] => cs.map((nid) => { const n = this.nodes.get(nid); if (!n) throw new Error(`Slab '${id}' references missing node '${nid}'`); return { x: n.x.get(), y: n.y.get() }; });
    const areaM2 = derived(() => { const p = cornerPoints(); let a2 = 0; for (let i = 0; i < p.length; i++) { const u = p[i], v = p[(i + 1) % p.length]; a2 += u.x * v.y - v.x * u.y; } return Math.abs(a2) / 2; });
    const sizing = derived(() => sizeSlabRule.evaluate({ corners: cornerPoints(), loadKnPerM2: load.get() }, this.ctx));
    this.slabs.set(id, { id, corners: cs, loadKnPerM2: load, areaM2, sizing });
    this.bump();
    return this;
  }
  setSlabLoad(id: string, loadKnPerM2: number): this { const s = this.slabs.get(id); if (!s) throw new Error(`setSlabLoad: unknown slab '${id}'`); s.loadKnPerM2.set(finite(loadKnPerM2, 'slab load')); return this; }
  removeSlab(id: string): this { this.slabs.delete(id); this.bump(); return this; }

  moveNode(id: string, x: number, y: number): this { const n = this.nodes.get(id); if (!n) throw new Error(`moveNode: unknown node '${id}'`); n.x.set(finite(x, 'x')); n.y.set(finite(y, 'y')); return this; }
  setElevation(id: string, z: number): this { const n = this.nodes.get(id); if (!n) throw new Error(`setElevation: unknown node '${id}'`); n.z.set(finite(z, 'elevation')); return this; }
  setRotation(id: string, deg: number): this { const n = this.nodes.get(id); if (!n) throw new Error(`setRotation: unknown node '${id}'`); n.rotationDeg.set(((finite(deg, 'rotation') % 360) + 360) % 360); return this; }
  setFixtureType(id: string, fixtureType: string): this { const n = this.nodes.get(id); if (!n || !n.fixtureType) throw new Error(`setFixtureType: '${id}' is not a fixture`); n.fixtureType.set(String(fixtureType)); return this; }
  setLoad(id: string, amps: number): this { const n = this.nodes.get(id); if (!n || !n.loadA) throw new Error(`setLoad: '${id}' is not an electrical load`); n.loadA.set(Math.max(0, finite(amps, 'design current'))); return this; }
  setAirflow(id: string, airLps: number): this { const n = this.nodes.get(id); if (!n || !n.airflowLps) throw new Error(`setAirflow: '${id}' is not a diffuser`); n.airflowLps.set(Math.max(0, finite(airLps, 'airflow'))); return this; }
  setBeamLoad(id: string, loadKnPerM: number): this { const p = this.pipes.get(id); if (!p || !p.beamLoad) throw new Error(`setBeamLoad: '${id}' is not a beam`); p.beamLoad.set(Math.max(0, finite(loadKnPerM, 'beam load'))); return this; }
  setAxialLoad(id: string, kn: number | null): this { const n = this.nodes.get(id); if (!n || !n.axialOverrideKn) throw new Error(`setAxialLoad: '${id}' is not a column/support`); n.axialOverrideKn.set(kn === null ? null : Math.max(0, finite(kn, 'axial load'))); return this; }
  setFloorsSupported(id: string, floors: number): this { const n = this.nodes.get(id); if (!n || !n.floorsSupported) throw new Error(`setFloorsSupported: '${id}' is not a column/support`); n.floorsSupported.set(Math.max(1, Math.round(finite(floors, 'floors supported')))); return this; }
  setPipeSlope(id: string, slopePct: number): this { const p = this.pipes.get(id); if (!p || !p.slopePct) throw new Error(`setPipeSlope: '${id}' is not a drainage pipe`); p.slopePct.set(Math.max(0, finite(slopePct, 'slope'))); return this; }
  setStackFloors(id: string, floors: number): this { const p = this.pipes.get(id); if (!p || !p.stackFloors) throw new Error(`setStackFloors: '${id}' is not a drainage pipe`); p.stackFloors.set(Math.max(1, Math.round(finite(floors, 'stack floors')))); return this; }
  setPipeSize(id: string, odMm: number | null): this { const p = this.pipes.get(id); if (!p) throw new Error(`setPipeSize: unknown pipe '${id}'`); p.manualOd.set(odMm === null ? null : finite(odMm, 'pipe size')); return this; }
  setPipeProduct(id: string, product: PipeProduct | null): this {
    const p = this.pipes.get(id);
    if (!p) throw new Error(`setPipeProduct: unknown pipe '${id}'`);
    if (product === null) { p.product.set(null); return this; }
    p.product.set({
      name: String(product.name), material: String(product.material),
      odMm: finite(product.odMm, 'product outside diameter'),
      pn: product.pn === undefined ? undefined : finite(product.pn, 'product pressure rating'),
      price: product.price === undefined ? undefined : finite(product.price, 'product price'),
    });
    return this;
  }
  setPipeWaypoints(id: string, waypoints: readonly Waypoint[]): this { const p = this.pipes.get(id); if (!p) throw new Error(`setPipeWaypoints: unknown pipe '${id}'`); p.waypoints.set(waypoints.map((w, i) => ({ x: finite(w.x, `waypoint ${i} x`), y: finite(w.y, `waypoint ${i} y`) }))); return this; }

  setSource(id: string): this { if (!this.nodes.has(id)) throw new Error(`setSource: unknown node '${id}'`); this.sourceId = id; this.bump(); return this; }
  setOutlet(id: string): this { if (!this.nodes.has(id)) throw new Error(`setOutlet: unknown node '${id}'`); this.outletId = id; this.bump(); return this; }
  setVentTerminal(id: string): this { if (!this.nodes.has(id)) throw new Error(`setVentTerminal: unknown node '${id}'`); this.ventRootId = id; this.bump(); return this; }
  setPanel(id: string): this { if (!this.nodes.has(id)) throw new Error(`setPanel: unknown node '${id}'`); this.panelId = id; this.bump(); return this; }
  setAhu(id: string): this { if (!this.nodes.has(id)) throw new Error(`setAhu: unknown node '${id}'`); this.ahuId = id; this.bump(); return this; }

  removePipe(id: string): this { this.pipes.delete(id); this.bump(); return this; }
  removeNode(id: string): this {
    this.nodes.delete(id);
    for (const [pid, p] of [...this.pipes]) if (p.from === id || p.to === id) this.pipes.delete(pid);
    for (const [sid, s] of [...this.slabs]) if (s.corners.includes(id)) this.slabs.delete(sid); // a slab losing a corner is invalid
    if (this.sourceId === id) this.sourceId = null;
    if (this.outletId === id) this.outletId = null;
    if (this.ventRootId === id) this.ventRootId = null;
    if (this.panelId === id) this.panelId = null;
    if (this.ahuId === id) this.ahuId = null;
    this.bump();
    return this;
  }
}

function computeTopology(nodes: Map<string, LayoutNode>, pipes: Map<string, LayoutPipe>, roots: Record<System, string | null>): Topology {
  const result = new Map<string, string[]>();
  const bySystem: Record<System, LayoutPipe[]> = { supply: [], drainage: [], vent: [], power: [], air: [], structure: [] };
  for (const p of pipes.values()) bySystem[systemOf(p.medium)].push(p);
  addSystem(result, nodes, bySystem.supply, roots.supply);
  addSystem(result, nodes, bySystem.drainage, roots.drainage);
  addSystem(result, nodes, bySystem.vent, roots.vent);
  addSystem(result, nodes, bySystem.power, roots.power);
  addSystem(result, nodes, bySystem.air, roots.air);
  addSystem(result, nodes, bySystem.structure, roots.structure); // beams: no flow root → all downstream = []
  return { downstreamFixturesByPipe: result };
}

function addSystem(result: Map<string, string[]>, nodes: Map<string, LayoutNode>, pipes: LayoutPipe[], rootId: string | null): void {
  if (rootId === null || !nodes.has(rootId)) { for (const p of pipes) result.set(p.id, []); return; }
  const adj = new Map<string, string[]>();
  const touch = (n: string) => { if (!adj.has(n)) adj.set(n, []); };
  touch(rootId);
  for (const p of pipes) { touch(p.from); touch(p.to); adj.get(p.from)!.push(p.to); adj.get(p.to)!.push(p.from); }

  const parent = new Map<string, string | null>([[rootId, null]]);
  const order: string[] = [];
  const visited = new Set<string>([rootId]);
  const queue: string[] = [rootId];
  while (queue.length) { const n = queue.shift()!; order.push(n); for (const m of adj.get(n) ?? []) if (!visited.has(m)) { visited.add(m); parent.set(m, n); queue.push(m); } }

  const children = new Map<string, string[]>();
  for (const [node, p] of parent) if (p !== null) { const l = children.get(p) ?? []; l.push(node); children.set(p, l); }

  const subtree = new Map<string, string[]>();
  for (let i = order.length - 1; i >= 0; i--) {
    const n = order[i];
    const acc: string[] = [];
    const k = nodes.get(n)?.kind;
    if (k === 'fixture' || k === 'load' || k === 'diffuser') acc.push(n); // terminals of any discipline
    for (const c of children.get(n) ?? []) for (const f of subtree.get(c) ?? []) acc.push(f);
    subtree.set(n, acc);
  }

  for (const p of pipes) {
    let child: string | null = null;
    if (parent.get(p.to) === p.from) child = p.to;
    else if (parent.get(p.from) === p.to) child = p.from;
    result.set(p.id, child ? (subtree.get(child) ?? []) : []);
  }
}
