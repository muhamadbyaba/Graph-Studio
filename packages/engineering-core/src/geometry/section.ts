/**
 * Horizontal section cut — deriving a real 2D floor plan from a 3D triangle mesh (e.g. an imported
 * IFC building). A floor plan is not a top-down projection of everything; it is the set of lines
 * where the building is sliced by a horizontal plane at a given height (walls, columns, openings).
 * This module computes that cut deterministically, so an imported model becomes a traceable plan
 * underlay for MEP routing. Pure geometry — no dependencies, fully testable.
 */

export interface Vec2 { x: number; y: number; }
export interface Segment2 { a: Vec2; b: Vec2; }
export interface Bounds2 { minX: number; minY: number; maxX: number; maxY: number; }

interface V3 { x: number; y: number; z: number; }

/** Intersect one triangle with the horizontal plane z = cutZ → the crossing segment, or null. */
function triangleCut(a: V3, b: V3, c: V3, cutZ: number): Segment2 | null {
  const da = a.z - cutZ, db = b.z - cutZ, dc = c.z - cutZ;
  const pts: Vec2[] = [];
  // An edge crosses the plane when its endpoints sit on opposite sides (on-plane counts as +side).
  const edge = (p: V3, q: V3, dp: number, dq: number): void => {
    if ((dp < 0 && dq >= 0) || (dp >= 0 && dq < 0)) {
      const t = dp / (dp - dq); // parameter of the crossing along p→q
      pts.push({ x: p.x + t * (q.x - p.x), y: p.y + t * (q.y - p.y) });
    }
  };
  edge(a, b, da, db);
  edge(b, c, db, dc);
  edge(c, a, dc, da);
  return pts.length === 2 ? { a: pts[0], b: pts[1] } : null; // 1 or 3 ⇒ degenerate (vertex on plane)
}

/** Min/max Z over a flat [x,y,z, x,y,z, …] vertex buffer. */
export function zRange(positions: ArrayLike<number>): { min: number; max: number } {
  let min = Infinity, max = -Infinity;
  for (let i = 2; i < positions.length; i += 3) {
    const z = positions[i];
    if (z < min) min = z;
    if (z > max) max = z;
  }
  if (!Number.isFinite(min)) { min = 0; max = 0; }
  return { min, max };
}

/**
 * Slice a triangle mesh with the plane z = cutZ, returning the plan-view (x,y) wall lines.
 * @param positions flat world-space vertex buffer [x0,y0,z0, x1,y1,z1, …]
 * @param indices   flat triangle index buffer [i0,i1,i2, …]
 */
export function sliceMeshAtZ(positions: ArrayLike<number>, indices: ArrayLike<number>, cutZ: number): Segment2[] {
  const segs: Segment2[] = [];
  const vertex = (i: number): V3 => ({ x: positions[i * 3], y: positions[i * 3 + 1], z: positions[i * 3 + 2] });
  for (let t = 0; t + 2 < indices.length; t += 3) {
    const s = triangleCut(vertex(indices[t]), vertex(indices[t + 1]), vertex(indices[t + 2]), cutZ);
    if (s) segs.push(s);
  }
  return segs;
}

/** Axis-aligned bounds of a set of segments (null if empty). */
export function segmentBounds(segs: Segment2[]): Bounds2 | null {
  if (segs.length === 0) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const s of segs) {
    for (const p of [s.a, s.b]) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
  }
  return { minX, minY, maxX, maxY };
}

/**
 * Scale + translate segments to fit a boxW × boxH canvas (metres), preserving aspect ratio and
 * centring, with a uniform margin. flipY maps model "north-up" to SVG "y-down" so the plan reads
 * the right way up. Returns canvas-space segments ready to draw.
 */
export function fitSegmentsToBox(segs: Segment2[], boxW: number, boxH: number, margin = 1, flipY = true): Segment2[] {
  const b = segmentBounds(segs);
  if (!b) return [];
  const srcW = Math.max(b.maxX - b.minX, 1e-9), srcH = Math.max(b.maxY - b.minY, 1e-9);
  const availW = Math.max(boxW - 2 * margin, 1e-9), availH = Math.max(boxH - 2 * margin, 1e-9);
  const scale = Math.min(availW / srcW, availH / srcH); // uniform ⇒ no distortion
  const drawW = srcW * scale, drawH = srcH * scale;
  const offX = (boxW - drawW) / 2, offY = (boxH - drawH) / 2;
  const map = (p: Vec2): Vec2 => {
    const x = offX + (p.x - b.minX) * scale;
    const yUp = offY + (p.y - b.minY) * scale;
    return { x, y: flipY ? boxH - yUp : yUp };
  };
  return segs.map((s) => ({ a: map(s.a), b: map(s.b) }));
}
