import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PlumbingLayout } from '../src/model/layout.ts';
import { GULF_V1 } from '../src/jurisdiction/gulf.ts';

test('a pipe length is the straight distance until it is rerouted through waypoints', () => {
  const L = new PlumbingLayout(GULF_V1);
  L.addNode('t', 'source', 0, 0);
  L.addNode('f', 'fixture', 3, 4, 'Lavatory'); // straight distance 5
  L.addPipe('p', 't', 'f', 'cold');
  assert.equal(Math.round(L.pipes.get('p')!.lengthM.get()), 5);
  // route it as an L through the corner (3,0): legs 3 + 4 = 7
  L.setPipeWaypoints('p', [{ x: 3, y: 0 }]);
  assert.equal(L.pipes.get('p')!.lengthM.get(), 7);
});

test('rerouting a longer path increases head loss (routed length drives the hydraulics)', () => {
  const L = new PlumbingLayout(GULF_V1);
  L.addNode('t', 'source', 0, 0);
  L.addNode('f', 'fixture', 10, 0, 'WaterCloset');
  L.addPipe('p', 't', 'f', 'cold');
  const straight = L.pipes.get('p')!.headlossM.get();
  L.setPipeWaypoints('p', [{ x: 5, y: 6 }, { x: 10, y: 6 }]); // detour up and over
  const routed = L.pipes.get('p')!.headlossM.get();
  assert.ok(L.pipes.get('p')!.lengthM.get() > 10, 'routed length grew');
  assert.ok(routed > straight, 'longer route ⇒ more head loss');
});

test('waypoints round-trip through addPipe and can be cleared', () => {
  const L = new PlumbingLayout(GULF_V1);
  L.addNode('t', 'source', 0, 0);
  L.addNode('f', 'fixture', 6, 0, 'Lavatory');
  L.addPipe('p', 't', 'f', 'cold', undefined, [{ x: 3, y: 3 }]);
  assert.equal(L.pipes.get('p')!.waypoints.get().length, 1);
  assert.equal(L.pipes.get('p')!.lengthM.get(), Math.hypot(3, 3) * 2); // 0→(3,3)→(6,0)
  L.setPipeWaypoints('p', []);
  assert.equal(L.pipes.get('p')!.waypoints.get().length, 0);
  assert.equal(L.pipes.get('p')!.lengthM.get(), 6);
});
