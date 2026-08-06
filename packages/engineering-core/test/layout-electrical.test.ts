import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PlumbingLayout } from '../src/model/layout.ts';
import { GULF_V1 } from '../src/jurisdiction/gulf.ts';
import { approx } from './helpers.ts';

/** panel(0,0) — cable — junction(5,0) — {load(5,3), load(30,0)} */
function circuit(): PlumbingLayout {
  return new PlumbingLayout(GULF_V1)
    .addNode('db', 'panel', 0, 0)
    .addNode('j', 'junction', 5, 0)
    .addNode('l1', 'load', 5, 3)
    .addNode('l2', 'load', 30, 0)
    .addPipe('feed', 'db', 'j', 'power')
    .addPipe('c1', 'j', 'l1', 'power')
    .addPipe('c2', 'j', 'l2', 'power');
}

test('cable carries the cumulative current of its downstream loads', () => {
  const net = circuit();
  approx(net.pipes.get('feed')!.cumulativeAmps.get(), 20, 1e-9); // two 10 A loads
  approx(net.pipes.get('c1')!.cumulativeAmps.get(), 10, 1e-9);
});

test('cable is sized (CSA) by ampacity + voltage drop', () => {
  const net = circuit();
  const feed = net.pipes.get('feed')!;
  assert.equal(typeof feed.sizing.get().value, 'number'); // a CSA in mm²
  assert.equal(feed.sizing.get().pass, true);
});

test('a cable auto-upsizes for voltage drop; an impossibly long run fails sizing', () => {
  const net = circuit();
  const short = net.pipes.get('c2')!.sizing.get().value as number;
  net.moveNode('l2', 60, 0); // longer run → sizer picks a bigger CSA to hold Vd
  assert.ok((net.pipes.get('c2')!.sizing.get().value as number) >= short);
  net.moveNode('l2', 600, 0); // ~600 m at 10 A → no catalog cable satisfies ampacity + Vd
  assert.equal(net.pipes.get('c2')!.sizing.get().pass, false);
  assert.equal(net.pipes.get('c2')!.sizing.get().value, null);
});

test('changing a load current changes the upstream cable sizing basis', () => {
  const net = circuit();
  const feed = net.pipes.get('feed')!;
  const before = feed.cumulativeAmps.get();
  net.setLoad('l1', 25);
  approx(feed.cumulativeAmps.get(), before + 15, 1e-9); // 10 → 25 adds 15 A
});

test('BOQ lists cable by CSA and electrical points', () => {
  const net = circuit();
  const codes = net.boq.get().map((l) => l.itemCode);
  assert.ok(codes.some((c) => c.startsWith('CABLE-')));
  assert.ok(codes.includes('ELEC-load'));
});

test('electrical is independent of the plumbing systems', () => {
  const net = circuit()
    .addNode('tank', 'source', 0, 8)
    .addNode('wc', 'fixture', 5, 8, 'WaterCloset')
    .addPipe('sup', 'tank', 'wc', 'cold');
  approx(net.pipes.get('sup')!.cumulativeWsfu.get(), 2.2, 1e-9); // plumbing still WSFU
  approx(net.pipes.get('feed')!.cumulativeAmps.get(), 20, 1e-9); // electrical still amps
  assert.equal(net.pipes.get('sup')!.cumulativeAmps.get(), 0);
});
