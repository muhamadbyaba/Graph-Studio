import { Quantity, mps, round } from '@buildgraph/engineering-core';
import type { JurisdictionPack, PlumbingLayout, RuleResult } from '@buildgraph/engineering-core';
import type { ProjectMeta, WorkspaceDocument } from './documents.ts';

/**
 * Flatten the reactive model into the JSON the browser renders.
 *
 * The reactive graph is lazy, so reading a value here is what actually computes it. That makes this
 * function the single point where the whole design is evaluated: sizes, velocities, head losses,
 * the pressure balance, the drainage and vent connectivity check, the recirculation loop and the
 * priced bill of quantities all fall out of one pass. Nothing is computed twice, because the
 * derived cells memoise, and nothing is stale, because a change invalidated them.
 */

export interface StateSnapshot {
  jurisdiction: string;
  fixtureTypes: string[];
  sizeOptions: Record<string, number[]>;
  nodes: NodeDto[];
  pipes: PipeDto[];
  slabs: SlabDto[];
  boq: BoqDto[];
  costTotal: number;
  pressure: unknown;
  recirc: unknown;
  dwv: unknown;
  meta: ProjectMeta;
  canUndo: boolean;
  canRedo: boolean;
  log: readonly unknown[];
}

export interface NodeDto {
  id: string; kind: string; x: number; y: number; z: number; rotationDeg: number;
  fixtureType: string | null; loadA: number | null; airflowLps: number | null;
  axialLoadKn: number | null; axialPerFloor: number | null; floorsSupported: number | null;
  axialOverride: number | null; axialFromBeams: number | null;
  column: ColumnDto | null;
}

interface ColumnDto {
  size: unknown; pass: boolean; reinforcement: string | null; capacity: string | null;
  utilization: string | null; steps: readonly unknown[]; clause: string;
}

export interface PipeDto {
  id: string; from: string; to: string; medium: string; lengthM: number;
  cumulativeWsfu: number; cumulativeDfu: number; cumulativeAmps: number; cumulativeAirLps: number;
  demandLps: number; sizeOd: unknown; sizePass: boolean; velocityMs: number | null; vdPct: number | null;
  velocityPass: boolean | null; headlossM: number; slopePct: number | null; slopePass: boolean | null;
  isStack: boolean; isOffset: boolean; stackFloors: number | null; perIntervalDfu: number;
  branchPass: boolean | null; branchLimit: unknown; manualOd: number | null; product: unknown;
  waypoints: readonly { x: number; y: number }[]; beamLoad: number | null; reinf: string | null;
  sizeSteps: readonly unknown[]; clause: string;
}

export interface SlabDto {
  id: string; corners: readonly string[]; loadKnPerM2: number; areaM2: number;
  thickness: unknown; pass: boolean; type: string | null; shortSpan: string | null;
  longSpan: string | null; steel: string | null; steps: readonly unknown[]; clause: string;
}

export interface BoqDto {
  itemCode: string; description: string; unit: string; qty: number;
  rate?: number; group?: string; lineCost: number;
}

export function serializeDocument(doc: WorkspaceDocument): StateSnapshot {
  const layout = doc.history.state();
  const pack = doc.pack;

  return {
    jurisdiction: `${pack.id}@${pack.version}`,
    fixtureTypes: Object.keys(pack.demand.wsfu),
    sizeOptions: {
      supply: pack.supply.pprCatalog.map((s) => s.odMm),
      drainage: (pack.drainage?.sizeTable ?? []).map((s) => s.odMm),
      vent: (pack.vent?.sizeTable ?? []).map((s) => s.odMm),
      power: (pack.electrical?.cableCatalog ?? []).map((c) => c.csaMm2),
      air: [...(pack.hvac?.ductCatalog ?? [])],
      structure: [...(pack.structural?.depthCatalog ?? [])],
    },
    nodes: serializeNodes(layout),
    pipes: serializePipes(layout),
    slabs: serializeSlabs(layout),
    ...serializeCost(layout),
    pressure: serializePressure(layout),
    recirc: serializeRecirc(layout),
    dwv: serializeDwv(layout),
    meta: doc.meta,
    canUndo: doc.history.canUndo,
    canRedo: doc.history.canRedo,
    log: [...doc.history.log()],
  };
}

/** The fixture and size catalogues a client needs before it can render controls. */
export function jurisdictionOptions(pack: JurisdictionPack): { id: string; version: string } {
  return { id: pack.id, version: pack.version };
}

function serializeNodes(layout: PlumbingLayout): NodeDto[] {
  return [...layout.nodes.values()].map((n) => ({
    id: n.id,
    kind: n.kind,
    x: n.x.get(),
    y: n.y.get(),
    z: n.z.get(),
    rotationDeg: n.rotationDeg.get(),
    fixtureType: n.fixtureType ? n.fixtureType.get() : null,
    loadA: n.loadA ? n.loadA.get() : null,
    airflowLps: n.airflowLps ? n.airflowLps.get() : null,
    // Total design load: the per-floor tributary multiplied by the number of typical floors carried.
    axialLoadKn: n.effectiveAxialKn ? round(n.effectiveAxialKn.get(), 1) : null,
    axialPerFloor: n.perFloorAxialKn ? round(n.perFloorAxialKn.get(), 1) : null,
    floorsSupported: n.floorsSupported ? n.floorsSupported.get() : null,
    axialOverride: n.axialOverrideKn ? n.axialOverrideKn.get() : null,
    axialFromBeams: n.derivedAxialKn ? round(n.derivedAxialKn.get(), 1) : null,
    column: serializeColumn(n.columnSizing?.get()),
  }));
}

function serializeColumn(result: RuleResult | undefined): ColumnDto | null {
  if (result === undefined) return null;
  return {
    size: result.value,
    pass: result.pass ?? false,
    reinforcement: result.trace.inputs.reinforcement ?? null,
    capacity: result.trace.inputs.capacity ?? null,
    utilization: result.trace.inputs.utilization ?? null,
    steps: result.trace.steps,
    clause: result.trace.clause,
  };
}

function serializePipes(layout: PlumbingLayout): PipeDto[] {
  return [...layout.pipes.values()].map((p) => {
    const sizing = p.sizing.get();
    const vel = p.velocity.get();
    return {
      id: p.id,
      from: p.from,
      to: p.to,
      medium: p.medium,
      lengthM: round(p.lengthM.get(), 2),
      cumulativeWsfu: round(p.cumulativeWsfu.get(), 2),
      cumulativeDfu: round(p.cumulativeDfu.get(), 2),
      cumulativeAmps: round(p.cumulativeAmps.get(), 1),
      cumulativeAirLps: round(p.cumulativeAirLps.get(), 0),
      demandLps: round(p.demandLps.get(), 3),
      sizeOd: sizing.value,
      sizePass: sizing.pass ?? false,
      velocityMs: vel.value instanceof Quantity ? round(vel.value.in(mps), 3) : null,
      // Power runs reuse the velocity slot to report percentage voltage drop.
      vdPct: p.medium === 'power' && typeof vel.value === 'number' ? round(vel.value, 2) : null,
      velocityPass: vel.pass ?? null,
      headlossM: round(p.headlossM.get(), 3),
      slopePct: p.slopePct ? p.slopePct.get() : null,
      slopePass: p.slopeCheck ? (p.slopeCheck.get().pass ?? null) : null,
      isStack: p.isStack.get(),
      isOffset: p.isOffset.get(),
      stackFloors: p.stackFloors ? p.stackFloors.get() : null,
      perIntervalDfu: round(p.perIntervalDfu.get(), 1),
      branchPass: p.stackBranchCheck ? (p.stackBranchCheck.get().pass ?? null) : null,
      branchLimit: p.stackBranchCheck ? (p.stackBranchCheck.get().value ?? null) : null,
      manualOd: p.manualOd.get(),
      product: p.product.get(),
      waypoints: p.waypoints.get(),
      beamLoad: p.beamLoad ? p.beamLoad.get() : null,
      reinf: sizing.trace.inputs.reinforcement ?? null,
      sizeSteps: sizing.trace.steps,
      clause: sizing.trace.clause,
    };
  });
}

function serializeSlabs(layout: PlumbingLayout): SlabDto[] {
  return [...layout.slabs.values()].map((sl) => {
    const r = sl.sizing.get();
    const inputs = r.trace.inputs;
    return {
      id: sl.id,
      corners: sl.corners,
      loadKnPerM2: sl.loadKnPerM2.get(),
      areaM2: round(sl.areaM2.get(), 2),
      thickness: r.value,
      pass: r.pass ?? false,
      type: inputs.type ?? null,
      shortSpan: inputs.shortSpan ?? null,
      longSpan: inputs.longSpan ?? null,
      steel: inputs.steel ?? null,
      steps: r.trace.steps,
      clause: r.trace.clause,
    };
  });
}

function serializeCost(layout: PlumbingLayout): { boq: BoqDto[]; costTotal: number } {
  const boq = layout.boq.get().map((l) => ({ ...l, lineCost: round((l.rate ?? 0) * l.qty, 2) }));
  return { boq, costTotal: round(boq.reduce((sum, l) => sum + l.lineCost, 0), 2) };
}

function serializePressure(layout: PlumbingLayout): unknown {
  const pr = layout.pressure.get();
  const remedy = layout.pressureRemedy();
  return {
    hasSource: pr.hasSource,
    remedy: remedy.needed
      ? {
        under: remedy.under, over: remedy.over,
        raiseSupplyToKPa: remedy.raiseSupplyToKPa, raiseCausesOverpressure: remedy.raiseCausesOverpressure,
        upsize: remedy.upsize, upsizeAchievesPass: remedy.upsizeAchievesPass,
        prvNeeded: remedy.prvNeeded, overByKPa: remedy.overByKPa,
      }
      : null,
    supplyPressureKPa: layout.supplyPressureKPa.get(),
    minResidualKPa: pr.minResidualKPa,
    maxPressureKPa: pr.maxPressureKPa,
    allPass: pr.allPass,
    failing: pr.failing,
    overpressure: pr.overpressure,
    worst: pr.worst ? { id: pr.worst.id, type: pr.worst.type, residualKPa: round(pr.worst.residualKPa, 1), pass: pr.worst.pass } : null,
    totalFrictionM: round(pr.totalFrictionM, 3),
    minorToCriticalM: round(pr.minorToCriticalM, 3),
    criticalFittings: pr.criticalFittings,
    criticalPipeIds: pr.criticalPipeIds,
    criticalNodeIds: pr.criticalNodeIds,
    fixtures: pr.fixtures.map((f) => ({ id: f.id, type: f.type, residualKPa: round(f.residualKPa, 1), pass: f.pass, over: f.over })),
    nodeResidual: Object.fromEntries([...pr.nodes].map(([id, np]) => [id, round(np.residualKPa, 1)])),
    assumptions: pr.assumptions,
  };
}

function serializeRecirc(layout: PlumbingLayout): unknown {
  const rc = layout.recirc.get();
  return {
    active: rc.active,
    recircFlowLps: layout.recircFlowLps.get(),
    loopPipeIds: rc.loopPipeIds,
    returnPipeId: rc.returnPipeId,
    loopLengthM: round(rc.loopLengthM, 2),
    frictionM: round(rc.frictionM, 3),
    pumpHeadKPa: round(rc.pumpHeadKPa, 1),
    returnVelocityMps: rc.returnVelocityMps != null ? round(rc.returnVelocityMps, 3) : null,
    branches: rc.branches.map((b) => ({
      returnPipeId: b.returnPipeId, loopPipeIds: b.loopPipeIds,
      loopLengthM: round(b.loopLengthM, 2), flowLps: round(b.flowLps, 3),
      frictionM: round(b.frictionM, 3), returnVelocityMps: round(b.returnVelocityMps, 3),
      isIndex: b.isIndex, balanceHeadM: round(b.balanceHeadM, 3),
      balanceValveKv: b.balanceValveKv != null ? round(b.balanceValveKv, 2) : null,
    })),
    assumptions: rc.assumptions,
  };
}

function serializeDwv(layout: PlumbingLayout): unknown {
  const dw = layout.dwv.get();
  return {
    active: dw.active,
    hasVentSystem: dw.hasVentSystem,
    totalDfu: dw.totalDfu,
    allDrained: dw.allDrained,
    allVented: dw.allVented,
    unconnectedDrains: dw.unconnectedDrains,
    unventedFixtures: dw.unventedFixtures,
    fixtures: dw.fixtures.map((f) => ({ id: f.id, type: f.type, dfu: f.dfu, drained: f.drained, vented: f.vented })),
    assumptions: dw.assumptions,
  };
}
