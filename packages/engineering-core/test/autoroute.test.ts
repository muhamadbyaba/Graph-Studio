import { test } from 'node:test';
import assert from 'node:assert/strict';
import { autoRouteEdges } from '../src/model/autoroute.ts';

test('auto-route returns a spanning tree (n-1 edges reaching every fixture)', () => {
  const pts = [
    { id: 's', x: 0, y: 0 },
    { id: 'a', x: 1, y: 0 },
    { id: 'b', x: 2, y: 0 },
    { id: 'c', x: 1, y: 1 },
  ];
  const edges = autoRouteEdges(pts, 's');
  assert.equal(edges.length, 3);
  assert.deepEqual([...new Set(edges.map((e) => e[1]))].sort(), ['a', 'b', 'c']);
});

test("Prim grows to the nearest point (s→a→b chain)", () => {
  const pts = [
    { id: 's', x: 0, y: 0 },
    { id: 'a', x: 1, y: 0 },
    { id: 'b', x: 2, y: 0 },
  ];
  assert.deepEqual(autoRouteEdges(pts, 's'), [['s', 'a'], ['a', 'b']]);
});

test('root-only or missing root yields no edges', () => {
  assert.deepEqual(autoRouteEdges([{ id: 's', x: 0, y: 0 }], 's'), []);
  assert.deepEqual(autoRouteEdges([{ id: 'a', x: 0, y: 0 }], 'missing'), []);
});
