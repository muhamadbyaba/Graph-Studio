import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PlumbingNetwork } from '../src/model/network.ts';
import { GULF_V1 } from '../src/jurisdiction/gulf.ts';
import { approx } from './helpers.ts';

/** Source → pipe → (WC + Lavatory + Shower). */
function villaBranch(): PlumbingNetwork {
  return new PlumbingNetwork(GULF_V1)
    .setSource('tank')
    .addPipe('p1', 'cold', 6)
    .addFixture('wc', 'WaterCloset')
    .addFixture('lav', 'Lavatory')
    .addFixture('sh', 'Shower')
    .connect('tank', 'p1')
    .connect('p1', 'wc')
    .connect('p1', 'lav')
    .connect('p1', 'sh');
}

test('cumulative WSFU sums the downstream fixtures', () => {
  const net = villaBranch();
  approx(net.pipes.get('p1')!.cumulativeWsfu.get(), 4.3, 1e-9); // 2.2 + 0.7 + 1.4
});

test('the pipe is sized and validated from the model', () => {
  const net = villaBranch();
  const p1 = net.pipes.get('p1')!;
  assert.equal(p1.sizing.get().pass, true);
  assert.equal(p1.velocity.get().pass, true);
});

test('BOQ is derived from the model and lists pipe + fixtures', () => {
  const net = villaBranch();
  const boq = net.boq.get();
  const codes = boq.map((l) => l.itemCode);
  assert.ok(codes.some((c) => c.startsWith('PPR-OD')));
  assert.ok(codes.includes('FIX-WaterCloset'));
  assert.ok(codes.includes('FIX-Shower'));
});

test('ADDING a fixture auto-updates cumulative WSFU and BOQ — no manual recompute', () => {
  const net = villaBranch();
  const p1 = net.pipes.get('p1')!;
  approx(p1.cumulativeWsfu.get(), 4.3, 1e-9);
  const before = net.boq.get().length;

  net.addFixture('ks', 'KitchenSink').connect('p1', 'ks'); // +1.4 WSFU → 5.7

  approx(p1.cumulativeWsfu.get(), 5.7, 1e-9);
  const codes = net.boq.get().map((l) => l.itemCode);
  assert.ok(codes.includes('FIX-KitchenSink'));
  assert.ok(net.boq.get().length > before);
});

test('a pipe AUTO-RESIZES when added demand exceeds the current size', () => {
  const net = villaBranch();
  const p1 = net.pipes.get('p1')!;
  assert.equal(p1.sizing.get().value, 20); // 4.3 WSFU → 0.215 L/s → OD20 (1.54 m/s ≤ 2.0)

  net.addFixture('ks', 'KitchenSink').connect('p1', 'ks'); // 5.7 WSFU → 0.285 L/s → OD20 fails (2.04 m/s)

  assert.equal(p1.sizing.get().value, 25); // auto-bumped to OD25, no manual intervention
});

test('editing one branch does NOT recompute an independent branch (incremental)', () => {
  const net = new PlumbingNetwork(GULF_V1)
    .setSource('tank')
    .addPipe('p1', 'cold', 4)
    .addPipe('p2', 'cold', 4)
    .addFixture('f1', 'WaterCloset')
    .addFixture('f2', 'WaterCloset')
    .connect('tank', 'p1')
    .connect('tank', 'p2')
    .connect('p1', 'f1')
    .connect('p2', 'f2');

  const p1 = net.pipes.get('p1')!;
  const p2 = net.pipes.get('p2')!;
  p1.sizing.get();
  p2.sizing.get();
  const p2Before = p2.sizing.computeCount;

  // Change a fixture on p1's branch only (a value change, not a topology change)
  net.fixtures.get('f1')!.type.set('Bathtub'); // WSFU 2.2 → 1.4

  p1.sizing.get(); // p1 re-solves
  assert.equal(p2.sizing.computeCount, p2Before); // p2 cell never recomputed — untouched
});
