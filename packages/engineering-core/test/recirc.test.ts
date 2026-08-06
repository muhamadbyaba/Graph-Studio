import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeRecirc, RHO_G_KPA_PER_M } from '../src/plumbing/recirc.ts';
import { PlumbingLayout } from '../src/model/layout.ts';
import { foldLayoutEvents } from '../src/events/layout-events.ts';
import type { LayoutEvent } from '../src/events/layout-events.ts';
import { GULF_V1 } from '../src/jurisdiction/gulf.ts';
import { hazenWilliamsHeadloss, pprInnerDiameter } from '../src/plumbing/hydraulics.ts';
import { qty, lps, mm, meter } from '../src/units/index.ts';
import { approx } from './helpers.ts';

// A hot tree with no return leg is not a recirculation system.
test('recirc: a hot tree (no return) is inactive', () => {
  const r = analyzeRecirc({
    sourceId: 'S', recircFlowLps: 0.1, hazenWilliamsC: 150,
    edges: [{ id: 'e1', from: 'S', to: 'A', odMm: 25, lengthM: 10, sdr: 6 }],
  });
  assert.equal(r.active, false);
  assert.equal(r.pumpHeadKPa, 0);
});

// GOLDEN — a closed loop S–A–B–S: pump head = Σ Hazen–Williams friction around the loop at the recirc flow.
test('recirc: closed loop pump head = loop friction × ρg', () => {
  const Q = 0.12;
  const edges = [
    { id: 'e1', from: 'S', to: 'A', odMm: 25, lengthM: 12, sdr: 6 },
    { id: 'e2', from: 'A', to: 'B', odMm: 25, lengthM: 12, sdr: 6 },
    { id: 'e3', from: 'B', to: 'S', odMm: 20, lengthM: 24, sdr: 6 }, // return leg
  ];
  const r = analyzeRecirc({ sourceId: 'S', recircFlowLps: Q, hazenWilliamsC: 150, edges });
  assert.equal(r.active, true);
  assert.equal(r.loopPipeIds.length, 3); // the whole loop
  const expected = edges.reduce((s, e) =>
    s + hazenWilliamsHeadloss(qty(Q, lps), pprInnerDiameter(qty(e.odMm, mm), e.sdr), 150, qty(e.lengthM, meter)).in(meter), 0);
  approx(r.frictionM, expected, 1e-9);
  approx(r.pumpHeadKPa, expected * RHO_G_KPA_PER_M, 1e-9);
  assert.ok(r.returnVelocityMps! > 0);
});

// Bigger loops need more pump head; zero recirc flow needs none (but the loop is still recognised).
test('recirc: pump head scales with flow, zero at zero flow', () => {
  const edges = [
    { id: 'e1', from: 'S', to: 'A', odMm: 20, lengthM: 15, sdr: 6 },
    { id: 'e2', from: 'A', to: 'S', odMm: 20, lengthM: 15, sdr: 6 },
  ];
  const lo = analyzeRecirc({ sourceId: 'S', recircFlowLps: 0.1, hazenWilliamsC: 150, edges });
  const hi = analyzeRecirc({ sourceId: 'S', recircFlowLps: 0.2, hazenWilliamsC: 150, edges });
  const zero = analyzeRecirc({ sourceId: 'S', recircFlowLps: 0, hazenWilliamsC: 150, edges });
  assert.ok(hi.pumpHeadKPa > lo.pumpHeadKPa);
  assert.equal(zero.active, true); // loop still exists
  assert.equal(zero.pumpHeadKPa, 0);
});

// Two return legs ⇒ two branches; the higher-friction one is the index (no valve), the other gets a
// balancing valve sized to dissipate the difference so both branches see equal head.
test('recirc: two branches → index has no valve, the other is balanced', () => {
  // Common trunk S→J. Two returns close two loops of different length.
  const edges = [
    { id: 't', from: 'S', to: 'J', odMm: 25, lengthM: 6, sdr: 6 },
    { id: 'a1', from: 'J', to: 'A', odMm: 20, lengthM: 8, sdr: 6 },
    { id: 'ar', from: 'A', to: 'S', odMm: 20, lengthM: 22, sdr: 6 }, // long branch (index)
    { id: 'b1', from: 'J', to: 'B', odMm: 20, lengthM: 5, sdr: 6 },
    { id: 'br', from: 'B', to: 'S', odMm: 20, lengthM: 9, sdr: 6 }, // short branch (needs a valve)
  ];
  const r = analyzeRecirc({ sourceId: 'S', recircFlowLps: 0.2, hazenWilliamsC: 150, edges });
  assert.equal(r.active, true);
  assert.equal(r.branches.length, 2);
  const idx = r.branches.filter((b) => b.isIndex);
  assert.equal(idx.length, 1, 'exactly one index branch');
  assert.equal(idx[0].balanceHeadM, 0);
  assert.equal(idx[0].balanceValveKv, null);
  const other = r.branches.find((b) => !b.isIndex)!;
  assert.ok(other.balanceHeadM > 0, 'the non-index branch must dissipate the difference');
  assert.ok(other.balanceValveKv! > 0, 'and gets a sized balancing valve (Kv)');
  // index balance head equals the friction difference to the index branch
  approx(other.balanceHeadM, idx[0].frictionM - other.frictionM, 1e-9);
  assert.equal(r.pumpHeadKPa, idx[0].frictionM * RHO_G_KPA_PER_M);
});

// ── Integration through the reactive layout ──────────────────────────────────

test('layout: recirc becomes active when a hot return closes the loop, and reacts to flow', () => {
  const L = new PlumbingLayout(GULF_V1);
  L.addNode('S', 'source', 0, 0).addNode('A', 'junction', 10, 0).addNode('B', 'junction', 10, 10);
  L.addPipe('e1', 'S', 'A', 'hot').addPipe('e2', 'A', 'B', 'hot');
  L.setSource('S').setRecircFlow(0.15);
  assert.equal(L.recirc.get().active, false); // still a tree — no return yet

  L.addPipe('e3', 'B', 'S', 'hot'); // draw the return leg → closes the loop
  const r = L.recirc.get();
  assert.equal(r.active, true);
  assert.equal(r.loopPipeIds.length, 3);
  assert.ok(r.pumpHeadKPa > 0);
  approx(r.pumpHeadKPa, r.frictionM * RHO_G_KPA_PER_M, 1e-9);

  const before = L.recirc.get().pumpHeadKPa;
  L.setRecircFlow(0.3); // more flow ⇒ more head
  assert.ok(L.recirc.get().pumpHeadKPa > before);

  L.removePipe('e3'); // remove the return ⇒ no loop
  assert.equal(L.recirc.get().active, false);
});

test('layout: RecircFlowSet event folds and replays', () => {
  const events: LayoutEvent[] = [
    { type: 'NodeAdded', id: 'S', kind: 'source', x: 0, y: 0 },
    { type: 'NodeAdded', id: 'A', kind: 'junction', x: 8, y: 0 },
    { type: 'PipeAdded', id: 'e1', from: 'S', to: 'A', medium: 'hot' },
    { type: 'PipeAdded', id: 'e2', from: 'A', to: 'S', medium: 'hot' },
    { type: 'SourceSet', id: 'S' },
    { type: 'RecircFlowSet', lps: 0.2 },
  ];
  const L = foldLayoutEvents(GULF_V1, events);
  assert.equal(L.recircFlowLps.get(), 0.2);
  assert.equal(L.recirc.get().active, true);
});
