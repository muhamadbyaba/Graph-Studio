// Isolated IFC loader — parses a dropped .ifc with web-ifc and returns a Three.js Group for the
// 3D view (a reference model to coordinate MEP against). Lazy-loaded only when an .ifc is dropped,
// and every caller wraps this in try/catch, so a failure here can never break the rest of the app.
import * as THREE from 'three';
import { IfcAPI } from 'web-ifc';

let api = null;
async function getApi() {
  if (api) return api;
  const a = new IfcAPI();
  a.SetWasmPath('/vendor/web-ifc/'); // where web-ifc.wasm is served
  await a.Init();
  api = a;
  return api;
}

export async function loadIfc(arrayBuffer) {
  const ifc = await getApi();
  const modelID = ifc.OpenModel(new Uint8Array(arrayBuffer));
  const group = new THREE.Group();
  const matCache = new Map();
  let meshCount = 0;

  ifc.StreamAllMeshes(modelID, (mesh) => {
    const placed = mesh.geometries;
    for (let i = 0; i < placed.size(); i++) {
      const pg = placed.get(i);
      const geom = ifc.GetGeometry(modelID, pg.geometryExpressID);
      const verts = ifc.GetVertexArray(geom.GetVertexData(), geom.GetVertexDataSize());
      const idx = ifc.GetIndexArray(geom.GetIndexData(), geom.GetIndexDataSize());
      const n = verts.length / 6;
      const pos = new Float32Array(n * 3), nor = new Float32Array(n * 3);
      for (let j = 0; j < n; j++) {
        pos[j * 3] = verts[j * 6]; pos[j * 3 + 1] = verts[j * 6 + 1]; pos[j * 3 + 2] = verts[j * 6 + 2];
        nor[j * 3] = verts[j * 6 + 3]; nor[j * 3 + 1] = verts[j * 6 + 4]; nor[j * 3 + 2] = verts[j * 6 + 5];
      }
      const bg = new THREE.BufferGeometry();
      bg.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      bg.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
      bg.setIndex(new THREE.BufferAttribute(new Uint32Array(idx), 1));

      const c = pg.color;
      const key = `${c.x.toFixed(2)}_${c.y.toFixed(2)}_${c.z.toFixed(2)}_${c.w.toFixed(2)}`;
      let mat = matCache.get(key);
      if (!mat) { mat = new THREE.MeshStandardMaterial({ color: new THREE.Color(c.x, c.y, c.z), transparent: c.w < 1, opacity: c.w, side: THREE.DoubleSide, roughness: 0.85 }); matCache.set(key, mat); }

      const m = new THREE.Mesh(bg, mat);
      m.matrixAutoUpdate = false;
      m.matrix.fromArray(pg.flatTransformation);
      group.add(m);
      meshCount++;
      if (typeof geom.delete === 'function') geom.delete();
    }
  });

  ifc.CloseModel(modelID);
  if (meshCount === 0) throw new Error('no geometry found in the IFC');
  return group;
}

/* --------------------------------------------------------------------------
 * IFC → 2D floor-plan underlay.
 * Extract world-space triangles, then section-cut them at a horizontal plane to get wall lines.
 * The cut/fit maths below is a faithful browser port of the CANONICAL, UNIT-TESTED implementation
 * in packages/engineering-core/src/geometry/section.ts (mirrored because the browser can't import
 * the TS engine without a build step). Keep the two in sync.
 * ------------------------------------------------------------------------ */

/** Merge all IFC meshes into one world-space triangle soup { positions:[x,y,z…], indices:[…] }. */
export async function extractIfcMesh(arrayBuffer) {
  const ifc = await getApi();
  const modelID = ifc.OpenModel(new Uint8Array(arrayBuffer));
  const positions = [];
  const indices = [];
  ifc.StreamAllMeshes(modelID, (mesh) => {
    const placed = mesh.geometries;
    for (let i = 0; i < placed.size(); i++) {
      const pg = placed.get(i);
      const geom = ifc.GetGeometry(modelID, pg.geometryExpressID);
      const verts = ifc.GetVertexArray(geom.GetVertexData(), geom.GetVertexDataSize());
      const idx = ifc.GetIndexArray(geom.GetIndexData(), geom.GetIndexDataSize());
      const m = pg.flatTransformation; // column-major 4×4 world placement
      const base = positions.length / 3;
      const n = verts.length / 6;
      for (let j = 0; j < n; j++) {
        const x = verts[j * 6], y = verts[j * 6 + 1], z = verts[j * 6 + 2];
        positions.push(
          m[0] * x + m[4] * y + m[8] * z + m[12],
          m[1] * x + m[5] * y + m[9] * z + m[13],
          m[2] * x + m[6] * y + m[10] * z + m[14],
        );
      }
      for (let k = 0; k < idx.length; k++) indices.push(base + idx[k]);
      if (typeof geom.delete === 'function') geom.delete();
    }
  });
  ifc.CloseModel(modelID);
  if (indices.length < 3) throw new Error('no geometry found in the IFC');
  return { positions, indices };
}

function zRange(positions) {
  let min = Infinity, max = -Infinity;
  for (let i = 2; i < positions.length; i += 3) { const z = positions[i]; if (z < min) min = z; if (z > max) max = z; }
  if (!Number.isFinite(min)) { min = 0; max = 0; }
  return { min, max };
}
function sliceMeshAtZ(positions, indices, cutZ) {
  const segs = [];
  const vx = (i) => ({ x: positions[i * 3], y: positions[i * 3 + 1], z: positions[i * 3 + 2] });
  for (let t = 0; t + 2 < indices.length; t += 3) {
    const a = vx(indices[t]), b = vx(indices[t + 1]), c = vx(indices[t + 2]);
    const da = a.z - cutZ, db = b.z - cutZ, dc = c.z - cutZ;
    const pts = [];
    const edge = (p, q, dp, dq) => {
      if ((dp < 0 && dq >= 0) || (dp >= 0 && dq < 0)) {
        const s = dp / (dp - dq);
        pts.push({ x: p.x + s * (q.x - p.x), y: p.y + s * (q.y - p.y) });
      }
    };
    edge(a, b, da, db); edge(b, c, db, dc); edge(c, a, dc, da);
    if (pts.length === 2) segs.push({ a: pts[0], b: pts[1] });
  }
  return segs;
}
function fitSegmentsToBox(segs, boxW, boxH, margin = 1, flipY = true) {
  if (segs.length === 0) return [];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const s of segs) for (const p of [s.a, s.b]) { if (p.x < minX) minX = p.x; if (p.y < minY) minY = p.y; if (p.x > maxX) maxX = p.x; if (p.y > maxY) maxY = p.y; }
  const srcW = Math.max(maxX - minX, 1e-9), srcH = Math.max(maxY - minY, 1e-9);
  const availW = Math.max(boxW - 2 * margin, 1e-9), availH = Math.max(boxH - 2 * margin, 1e-9);
  const scale = Math.min(availW / srcW, availH / srcH);
  const offX = (boxW - srcW * scale) / 2, offY = (boxH - srcH * scale) / 2;
  const map = (p) => { const x = offX + (p.x - minX) * scale; const yUp = offY + (p.y - minY) * scale; return { x, y: flipY ? boxH - yUp : yUp }; };
  return segs.map((s) => ({ a: map(s.a), b: map(s.b) }));
}

/** Section-cut a cached world mesh into canvas-space plan segments. cutFraction 0..1 up the height. */
export function planFromMesh(mesh, cutFraction = 0.5, box = { w: 26, h: 15 }) {
  const { min, max } = zRange(mesh.positions);
  const frac = Math.min(0.98, Math.max(0.02, cutFraction));
  const cutZ = min + frac * (max - min);
  const segments = fitSegmentsToBox(sliceMeshAtZ(mesh.positions, mesh.indices, cutZ), box.w, box.h, 1);
  return { segments, cutZ, zMin: min, zMax: max };
}
