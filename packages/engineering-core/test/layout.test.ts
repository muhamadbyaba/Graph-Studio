import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PlumbingLayout } from '../src/model/layout.ts';
import { foldLayoutEvents } from '../src/events/layout-events.ts';
import { History } from '../src/events/generic-history.ts';
import type { LayoutEvent } from '../src/events/layout-events.ts';
import { GULF_V1 } from '../src/jurisdiction/gulf.ts';
import { approx } from './helpers.ts';

/** tank(0,0) — pipe — junction(5,0) — {WC(5,2), Shower(8,0)} */
function branch(): PlumbingLayout {
  return new PlumbingLayout(GULF_V1)
    .addNode('tank', 'source', 0, 0)
    .addNode('j', 'junction', 5, 0)
    .addNode('wc', 'fixture', 5, 2, 'WaterCloset')
    .addNode('sh', 'fixture', 8, 0, 'Shower')
    .addPipe('main', 'tank', 'j', 'cold')
    .addPipe('bwc', 'j', 'wc', 'cold')
    .addPipe('bsh', 'j', 'sh', 'cold');
}

test('pipe length is derived from node geometry (distance)', () => {
  const net = branch();
  approx(net.pipes.get('main')!.lengthM.get(), 5, 1e-9); // (0,0)→(5,0)
  approx(net.pipes.get('bwc')!.lengthM.get(), 2, 1e-9); // (5,0)→(5,2)
  approx(net.pipes.get('bsh')!.lengthM.get(), 3, 1e-9); // (5,0)→(8,0)
});

test('moving a node changes the pipe length AND its head loss', () => {
  const net = branch();
  const main = net.pipes.get('main')!;
  const len0 = main.lengthM.get();
  const hl0 = main.headlossM.get();
  net.moveNode('j', 10, 0); // pull the junction out to 10 m
  approx(main.lengthM.get(), 10, 1e-9);
  assert.ok(main.headlossM.get() > hl0); // longer run → more head loss
  assert.ok(main.lengthM.get() > len0);
});

test('cumulative WSFU per pipe follows the tree (main carries both fixtures)', () => {
  const net = branch();
  approx(net.pipes.get('main')!.cumulativeWsfu.get(), 3.6, 1e-9); // WC 2.2 + Shower 1.4
  approx(net.pipes.get('bwc')!.cumulativeWsfu.get(), 2.2, 1e-9); // just the WC
  approx(net.pipes.get('bsh')!.cumulativeWsfu.get(), 1.4, 1e-9); // just the Shower
});

test('pipes are sized from the geometry-derived demand', () => {
  const net = branch();
  assert.equal(net.pipes.get('main')!.sizing.get().pass, true);
  assert.equal(typeof net.pipes.get('main')!.sizing.get().value, 'number');
});

test('removing a fixture drops the load and removes its pipe', () => {
  const net = branch();
  approx(net.pipes.get('main')!.cumulativeWsfu.get(), 3.6, 1e-9);
  net.removeNode('sh'); // removes the Shower and pipe bsh
  approx(net.pipes.get('main')!.cumulativeWsfu.get(), 2.2, 1e-9);
  assert.equal(net.pipes.has('bsh'), false);
});

test('BOQ lists pipes (by size) and fixtures, and reacts to a drag', () => {
  const net = branch();
  const codes = () => net.boq.get().map((l) => l.itemCode);
  assert.ok(codes().includes('FIX-WaterCloset'));
  assert.ok(codes().some((c) => c.startsWith('PPR-OD')));
  const mainQtyBefore = net.boq.get().find((l) => l.itemCode.startsWith('PPR-OD'))!.qty;
  net.moveNode('j', 20, 0); // longer main pipe → more metres in the BOQ
  const mainQtyAfter = net.boq.get().reduce((s, l) => (l.unit === 'm' ? s + l.qty : s), 0);
  assert.ok(mainQtyAfter > mainQtyBefore);
});

test('layout event history: build → drag → undo/redo replays geometry', () => {
  const events: LayoutEvent[] = [
    { type: 'NodeAdded', id: 'tank', kind: 'source', x: 0, y: 0 },
    { type: 'NodeAdded', id: 'wc', kind: 'fixture', x: 3, y: 4, fixtureType: 'WaterCloset' },
    { type: 'PipeAdded', id: 'p', from: 'tank', to: 'wc', medium: 'cold' },
  ];
  const history = new History<LayoutEvent, PlumbingLayout>((evts) => foldLayoutEvents(GULF_V1, evts));
  for (const e of events) history.do(e);
  approx(history.state().pipes.get('p')!.lengthM.get(), 5, 1e-9); // 3-4-5

  history.do({ type: 'NodeMoved', id: 'wc', x: 6, y: 8 }); // 6-8-10
  approx(history.state().pipes.get('p')!.lengthM.get(), 10, 1e-9);

  approx(history.undo().pipes.get('p')!.lengthM.get(), 5, 1e-9); // back to 3-4-5
  approx(history.redo().pipes.get('p')!.lengthM.get(), 10, 1e-9); // redo the drag
});
