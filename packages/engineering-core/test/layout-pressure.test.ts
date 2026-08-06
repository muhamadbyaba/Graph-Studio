import { test } from 'node:test';
import assert from 'node:assert/strict';
import { solveNetworkPressure, RHO_G_KPA_PER_M } from '../src/plumbing/pressure.ts';
import { PlumbingLayout } from '../src/model/layout.ts';
import { foldLayoutEvents } from '../src/events/layout-events.ts';
import type { LayoutEvent } from '../src/events/layout-events.ts';
import { GULF_V1 } from '../src/jurisdiction/gulf.ts';
import { approx } from './helpers.ts';

// ── Pure solver: golden hand calculations ────────────────────────────────────

// GOLDEN — pure gravity (0 supply pressure), tank 10 m above a loss-free fixture:
//   residual = 0 + 9.80665·(10 − 0) − 0 = 98.0665 kPa
test('pressure: 10 m static head with no friction ≈ 98.07 kPa', () => {
  const a = solveNetworkPressure({
    sourceId: 'S', supplyPressureKPa: 0, minResidualKPa: 100, maxPressureKPa: 500,
    nodes: [{ id: 'S', z: 10, isFixture: false }, { id: 'F', z: 0, isFixture: true, type: 'Lavatory' }],
    edges: [{ id: 'p1', from: 'S', to: 'F', headlossM: 0 }],
  });
  approx(a.fixtures[0].residualKPa, 10 * RHO_G_KPA_PER_M, 1e-6);
  approx(a.worst!.residualKPa, 98.0665, 1e-3);
});

// GOLDEN — 300 kPa boosted supply, level run, 2 m friction:
//   residual = 300 − 9.80665·2 = 280.3867 kPa
test('pressure: 300 kPa less 2 m friction ≈ 280.39 kPa', () => {
  const a = solveNetworkPressure({
    sourceId: 'S', supplyPressureKPa: 300, minResidualKPa: 100, maxPressureKPa: 500,
    nodes: [{ id: 'S', z: 0, isFixture: false }, { id: 'F', z: 0, isFixture: true }],
    edges: [{ id: 'p1', from: 'S', to: 'F', headlossM: 2 }],
  });
  approx(a.worst!.residualKPa, 280.3867, 1e-3);
  assert.equal(a.allPass, true);
});

// The worst (governing) fixture and its critical path are the branch with the most head loss.
test('pressure: worst fixture + critical path pick the highest-loss branch', () => {
  const a = solveNetworkPressure({
    sourceId: 'S', supplyPressureKPa: 300, minResidualKPa: 100, maxPressureKPa: 500,
    nodes: [
      { id: 'S', z: 0, isFixture: false },
      { id: 'A', z: 0, isFixture: false },
      { id: 'F1', z: 0, isFixture: true, type: 'Lavatory' },
      { id: 'F2', z: 0, isFixture: true, type: 'WaterCloset' },
    ],
    edges: [
      { id: 'p1', from: 'S', to: 'A', headlossM: 1 },
      { id: 'p2', from: 'A', to: 'F1', headlossM: 1 },
      { id: 'p3', from: 'S', to: 'F2', headlossM: 5 },
    ],
  });
  assert.equal(a.worst!.id, 'F2'); // 5 m of loss beats the 2 m branch
  approx(a.worst!.residualKPa, 300 - 5 * RHO_G_KPA_PER_M, 1e-6);
  assert.deepEqual([...a.criticalPipeIds], ['p3']);
  assert.deepEqual([...a.criticalNodeIds], ['S', 'F2']);
});

// GOLDEN — fitting minor loss: a 90° elbow (K=0.9) at 2 m/s adds K·v²/2g = 0.9·4/(2·9.80665)
//   = 0.18355 m of head → 1.8001 kPa on top of the pipe friction.
test('pressure: fitting minor loss (K·v²/2g) is added on the path', () => {
  const noFit = solveNetworkPressure({
    sourceId: 'S', supplyPressureKPa: 300, minResidualKPa: 100, maxPressureKPa: 500,
    nodes: [{ id: 'S', z: 0, isFixture: false }, { id: 'F', z: 0, isFixture: true }],
    edges: [{ id: 'p1', from: 'S', to: 'F', headlossM: 1, velocityMps: 2 }],
  });
  const withFit = solveNetworkPressure({
    sourceId: 'S', supplyPressureKPa: 300, minResidualKPa: 100, maxPressureKPa: 500,
    nodes: [
      { id: 'S', z: 0, isFixture: false },
      { id: 'E', z: 0, isFixture: false, isFitting: true, fittingK: 0.9 },
      { id: 'F', z: 0, isFixture: true },
    ],
    edges: [
      { id: 'p1', from: 'S', to: 'E', headlossM: 1, velocityMps: 2 },
      { id: 'p2', from: 'E', to: 'F', headlossM: 0, velocityMps: 2 },
    ],
  });
  const dh = 0.9 * 4 / (2 * 9.80665); // 0.18355 m
  approx(withFit.minorToCriticalM, dh, 1e-6);
  approx(withFit.criticalFittings, 1, 0);
  // residual drops by exactly the minor head (converted to kPa) vs the no-fitting case
  approx(noFit.worst!.residualKPa - withFit.worst!.residualKPa, dh * RHO_G_KPA_PER_M, 1e-6);
});

// GOLDEN — a tee's turn angle selects run vs branch K. Straight-through outlet (K=0.6) loses less than
// the 90° branch takeoff (K=1.8) at the same velocity → the branch outlet governs.
test('pressure: tee run vs branch K chosen by turn angle', () => {
  const a = solveNetworkPressure({
    sourceId: 'S', supplyPressureKPa: 400, minResidualKPa: 100, maxPressureKPa: 600,
    nodes: [
      { id: 'S', x: 0, y: 0, z: 0, isFixture: false },
      { id: 'T', x: 5, y: 0, z: 0, isFixture: false, isFitting: true, fittingK: 0.6, fittingKBranch: 1.8 },
      { id: 'R', x: 10, y: 0, z: 0, isFixture: true, type: 'Run' },   // straight through (0°)
      { id: 'B', x: 5, y: 5, z: 0, isFixture: true, type: 'Branch' }, // 90° takeoff
    ],
    edges: [
      { id: 'sT', from: 'S', to: 'T', headlossM: 0, velocityMps: 2 },
      { id: 'tR', from: 'T', to: 'R', headlossM: 0, velocityMps: 2 },
      { id: 'tB', from: 'T', to: 'B', headlossM: 0, velocityMps: 2 },
    ],
  });
  const dhRun = 0.6 * 4 / (2 * 9.80665);    // 0.12237 m
  const dhBranch = 1.8 * 4 / (2 * 9.80665); // 0.36710 m
  approx(a.nodes.get('R')!.minorM, dhRun, 1e-6);
  approx(a.nodes.get('B')!.minorM, dhBranch, 1e-6);
  assert.equal(a.worst!.id, 'B'); // the branch takeoff loses more → governs
});

// A fixture below the code minimum residual is flagged; an over-pressure fixture needs a PRV.
test('pressure: flags under-pressure and over-pressure fixtures', () => {
  const under = solveNetworkPressure({
    sourceId: 'S', supplyPressureKPa: 100, minResidualKPa: 100, maxPressureKPa: 500,
    nodes: [{ id: 'S', z: 0, isFixture: false }, { id: 'F', z: 0, isFixture: true }],
    edges: [{ id: 'p1', from: 'S', to: 'F', headlossM: 5 }], // 49 kPa lost → 51 kPa < 100
  });
  assert.equal(under.failing, 1);
  assert.equal(under.allPass, false);

  const over = solveNetworkPressure({
    sourceId: 'S', supplyPressureKPa: 600, minResidualKPa: 100, maxPressureKPa: 500,
    nodes: [{ id: 'S', z: 0, isFixture: false }, { id: 'F', z: 0, isFixture: true }],
    edges: [{ id: 'p1', from: 'S', to: 'F', headlossM: 0 }],
  });
  assert.equal(over.overpressure, 1);
  assert.equal(over.allPass, false);
});

// An orphaned fixture (no path to the source) is simply omitted from the pressure result.
test('pressure: fixture not connected to the source is omitted', () => {
  const a = solveNetworkPressure({
    sourceId: 'S', supplyPressureKPa: 300, minResidualKPa: 100, maxPressureKPa: 500,
    nodes: [{ id: 'S', z: 0, isFixture: false }, { id: 'F', z: 0, isFixture: true }, { id: 'X', z: 0, isFixture: true }],
    edges: [{ id: 'p1', from: 'S', to: 'F', headlossM: 1 }], // X is disconnected
  });
  assert.equal(a.fixtures.length, 1);
  assert.equal(a.fixtures[0].id, 'F');
});

test('pressure: no source → empty analysis, hasSource false', () => {
  const a = solveNetworkPressure({
    sourceId: null, supplyPressureKPa: 300, minResidualKPa: 100, maxPressureKPa: 500,
    nodes: [{ id: 'F', z: 0, isFixture: true }], edges: [],
  });
  assert.equal(a.hasSource, false);
  assert.equal(a.worst, null);
});

// ── Integration through the reactive layout ──────────────────────────────────

test('layout: pressure analysis is live and reacts to supply pressure & elevation', () => {
  const L = new PlumbingLayout(GULF_V1);
  L.addNode('S', 'source', 0, 0).addNode('F', 'fixture', 3, 0, 'Lavatory');
  L.addPipe('e', 'S', 'F', 'cold');
  L.setSource('S').setSupplyPressure(300);

  const p1 = L.pressure.get();
  assert.equal(p1.hasSource, true);
  assert.equal(p1.worst!.id, 'F');
  const fp = p1.nodes.get('F')!;
  assert.ok(fp.frictionM >= 0, 'friction head is non-negative');
  // The governing identity: residual = supply + ρg·(static gain − friction).
  approx(p1.worst!.residualKPa, 300 + RHO_G_KPA_PER_M * (fp.staticGainM - fp.frictionM), 1e-6);

  // Raising the supply pressure by 50 kPa raises every residual by exactly 50 kPa.
  L.setSupplyPressure(350);
  approx(L.pressure.get().worst!.residualKPa, p1.worst!.residualKPa + 50, 1e-6);

  // Lifting the fixture 5 m loses 5·ρg of static head (relative to the 350 kPa case).
  const before = L.pressure.get().worst!.residualKPa;
  L.setElevation('F', L.nodes.get('F')!.z.get() + 5);
  approx(L.pressure.get().worst!.residualKPa, before - 5 * RHO_G_KPA_PER_M, 1e-6);
});

test('remedy: raising supply to the recommended pressure clears an under-pressure outlet', () => {
  const L = new PlumbingLayout(GULF_V1);
  L.addNode('S', 'source', 0, 0).addNode('F', 'fixture', 30, 0, 'HoseBibb');
  L.addPipe('e', 'S', 'F', 'cold');
  L.setSource('S').setSupplyPressure(80); // too low ⇒ fails
  assert.equal(L.pressure.get().allPass, false);
  const rem = L.pressureRemedy();
  assert.equal(rem.needed, true);
  assert.equal(rem.under, true);
  assert.ok(rem.raiseSupplyToKPa && rem.raiseSupplyToKPa >= 100, 'recommends a supply ≥ code minimum');
  L.setSupplyPressure(rem.raiseSupplyToKPa!);
  assert.equal(L.pressure.get().allPass, true, 'applying the recommendation clears it');
});

test('remedy: upsizing the critical path clears it at a fixed supply pressure', () => {
  const L = new PlumbingLayout(GULF_V1);
  L.addNode('S', 'source', 0, 0).addNode('F', 'fixture', 80, 0, 'HoseBibb'); // long friction-dominated run
  L.addPipe('e', 'S', 'F', 'cold');
  L.setSource('S').setSupplyPressure(100);
  assert.equal(L.pressure.get().allPass, false);
  const rem = L.pressureRemedy();
  assert.equal(rem.needed, true);
  if (rem.upsizeAchievesPass) {
    assert.ok(rem.upsize.length >= 1, 'at least one pipe upsized');
    for (const u of rem.upsize) { assert.ok(u.toOd > u.fromOd); L.setPipeSize(u.pipeId, u.toOd); }
    assert.equal(L.pressure.get().allPass, true, 'applying the upsize plan clears it at the same supply');
  } else {
    assert.ok(rem.raiseSupplyToKPa && rem.raiseSupplyToKPa > 100, 'if upsize cannot fix it, a supply raise is still offered');
  }
});

test('remedy: over-pressure flags a PRV, not a supply change', () => {
  const L = new PlumbingLayout(GULF_V1);
  L.addNode('S', 'source', 0, 0).addNode('F', 'fixture', 3, 0, 'Lavatory');
  L.addPipe('e', 'S', 'F', 'cold');
  L.setSource('S').setSupplyPressure(700); // above the 500 kPa max
  const rem = L.pressureRemedy();
  assert.equal(rem.over, true);
  assert.equal(rem.prvNeeded, true);
  assert.ok(rem.overByKPa > 0);
});

test('layout: SupplyPressureSet event folds and replays', () => {
  const events: LayoutEvent[] = [
    { type: 'NodeAdded', id: 'S', kind: 'source', x: 0, y: 0 },
    { type: 'NodeAdded', id: 'F', kind: 'fixture', x: 4, y: 0, fixtureType: 'Lavatory' },
    { type: 'PipeAdded', id: 'e', from: 'S', to: 'F', medium: 'cold' },
    { type: 'SourceSet', id: 'S' },
    { type: 'SupplyPressureSet', kPa: 420 },
  ];
  const L = foldLayoutEvents(GULF_V1, events);
  assert.equal(L.supplyPressureKPa.get(), 420);
  assert.equal(L.pressure.get().hasSource, true);
  assert.equal(L.pressure.get().worst!.id, 'F');
});
