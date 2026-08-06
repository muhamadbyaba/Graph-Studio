import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sliceMeshAtZ, segmentBounds, fitSegmentsToBox, zRange } from '../src/geometry/section.ts';

// Unit cube spanning [0,1]^3 — only the four SIDE faces (walls) are needed for a horizontal cut.
// prettier-ignore
const CUBE = {
  positions: [
    0, 0, 0,  1, 0, 0,  1, 1, 0,  0, 1, 0, // 0-3 bottom
    0, 0, 1,  1, 0, 1,  1, 1, 1,  0, 1, 1, // 4-7 top
  ],
  // four walls, two triangles each (front y=0, right x=1, back y=1, left x=0)
  indices: [
    0, 1, 5,  0, 5, 4,   // front  (y = 0)
    1, 2, 6,  1, 6, 5,   // right  (x = 1)
    2, 3, 7,  2, 7, 6,   // back   (y = 1)
    3, 0, 4,  3, 4, 7,   // left   (x = 0)
  ],
};

test('zRange reads the vertical extent', () => {
  const r = zRange(CUBE.positions);
  assert.equal(r.min, 0);
  assert.equal(r.max, 1);
});

test('slicing the cube at mid-height yields the wall perimeter', () => {
  const segs = sliceMeshAtZ(CUBE.positions, CUBE.indices, 0.5);
  assert.equal(segs.length, 8); // two crossing segments per side face
  // every endpoint must lie on the square boundary (x∈{0,1} or y∈{0,1})
  const onBoundary = (p: { x: number; y: number }) =>
    Math.min(Math.abs(p.x), Math.abs(p.x - 1), Math.abs(p.y), Math.abs(p.y - 1)) < 1e-9;
  for (const s of segs) { assert.ok(onBoundary(s.a)); assert.ok(onBoundary(s.b)); }
  const b = segmentBounds(segs)!;
  assert.deepEqual([b.minX, b.minY, b.maxX, b.maxY], [0, 0, 1, 1]);
});

test('the top and bottom cap planes produce no cut', () => {
  // z below and above the model → nothing crosses
  assert.equal(sliceMeshAtZ(CUBE.positions, CUBE.indices, -0.5).length, 0);
  assert.equal(sliceMeshAtZ(CUBE.positions, CUBE.indices, 1.5).length, 0);
});

test('fit scales and centres into the canvas without distortion', () => {
  const segs = sliceMeshAtZ(CUBE.positions, CUBE.indices, 0.5);
  const fitted = fitSegmentsToBox(segs, 26, 15, 1);
  const b = segmentBounds(fitted)!;
  // stays inside the 26×15 box with the 1 m margin respected
  assert.ok(b.minX >= 1 - 1e-6 && b.maxX <= 25 + 1e-6);
  assert.ok(b.minY >= 1 - 1e-6 && b.maxY <= 14 + 1e-6);
  // square in → square out (aspect preserved): width == height of the fitted footprint
  assert.ok(Math.abs((b.maxX - b.minX) - (b.maxY - b.minY)) < 1e-6);
});
