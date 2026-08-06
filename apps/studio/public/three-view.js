// 3D view for BuildGraph Studio (Three.js). Renders the layout as a realistic plumbing model:
// green PPR supply pipes with a cold/hot stripe, fitting hubs at joints, brass transitions at
// fixtures, uPVC drains near the floor, soft shadows.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const CEIL = 2.6;   // supply main height (m)
const DRAIN = 0.22; // drainage near floor (m)
const FIXT = 0.85;  // fixture connection height (m)

export function mount(container, opts = {}) {
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  container.innerHTML = '';
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xe9eef4);
  scene.fog = new THREE.Fog(0xe9eef4, 45, 90);

  const camera = new THREE.PerspectiveCamera(48, 1, 0.1, 500);
  camera.position.set(15, 13, 22);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.target.set(13, 1, 7.5);

  scene.add(new THREE.HemisphereLight(0xffffff, 0x8b95a4, 0.85));
  const sun = new THREE.DirectionalLight(0xfff6e6, 2.2);
  sun.position.set(16, 26, 10);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  const sc = sun.shadow.camera;
  sc.left = -26; sc.right = 40; sc.top = 30; sc.bottom = -16; sc.near = 1; sc.far = 90;
  scene.add(sun);

  const floor = new THREE.Mesh(new THREE.PlaneGeometry(80, 80), new THREE.MeshStandardMaterial({ color: 0xf2f5f9, roughness: 1 }));
  floor.rotation.x = -Math.PI / 2;
  floor.position.set(13, 0, 7.5);
  floor.receiveShadow = true;
  scene.add(floor);
  const grid = new THREE.GridHelper(80, 80, 0xccd5df, 0xe3e8ee);
  grid.position.set(13, 0.002, 7.5);
  scene.add(grid);

  // materials
  const M = {
    ppr: new THREE.MeshStandardMaterial({ color: 0x1f9d55, roughness: 0.35, metalness: 0.05 }),
    fitting: new THREE.MeshStandardMaterial({ color: 0x17864a, roughness: 0.4, metalness: 0.05 }),
    drain: new THREE.MeshStandardMaterial({ color: 0x9aa7a0, roughness: 0.6, metalness: 0.02 }),
    brass: new THREE.MeshStandardMaterial({ color: 0xc7a53a, roughness: 0.32, metalness: 0.85 }),
    stripeCold: new THREE.MeshStandardMaterial({ color: 0x1f6feb, roughness: 0.5 }),
    stripeHot: new THREE.MeshStandardMaterial({ color: 0xd1493c, roughness: 0.5 }),
    fixture: new THREE.MeshStandardMaterial({ color: 0xeef1f5, roughness: 0.25, metalness: 0.02 }),
    tank: new THREE.MeshStandardMaterial({ color: 0x14386e, roughness: 0.4, metalness: 0.1 }),
    outlet: new THREE.MeshStandardMaterial({ color: 0x2e4a3a, roughness: 0.7 }),
    vent: new THREE.MeshStandardMaterial({ color: 0xb5179e, roughness: 0.45, metalness: 0.05 }),
    power: new THREE.MeshStandardMaterial({ color: 0xe8590c, roughness: 0.5, metalness: 0.05 }),
    panel: new THREE.MeshStandardMaterial({ color: 0x3a4048, roughness: 0.5, metalness: 0.3 }),
    air: new THREE.MeshStandardMaterial({ color: 0x2aa5b8, roughness: 0.35, metalness: 0.55 }),
    beam: new THREE.MeshStandardMaterial({ color: 0x8a8f96, roughness: 0.9, metalness: 0.02 }),
  };

  const V = (x, y, z) => new THREE.Vector3(x, y, z);
  const hz = (n) => (typeof n.z === 'number' ? n.z : 1.5); // node elevation (m) — used by render, picking + highlight
  function perp(nd) { const up = Math.abs(nd.y) > 0.99 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0); return new THREE.Vector3().crossVectors(nd, up).normalize(); }

  function tube(group, p1, p2, r, mat) {
    const d = new THREE.Vector3().subVectors(p2, p1); const len = d.length();
    if (len < 1e-4) return;
    const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, len, 18), mat);
    m.position.copy(p1).addScaledVector(d, 0.5);
    m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.clone().normalize());
    m.castShadow = true;
    group.add(m);
  }
  function stripe(group, p1, p2, r, mat) {
    const d = new THREE.Vector3().subVectors(p2, p1); const len = d.length();
    if (len < 1e-4) return;
    const nd = d.clone().normalize();
    const m = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.16, r * 0.16, len * 0.98, 8), mat);
    m.position.copy(p1).addScaledVector(d, 0.5).add(perp(nd).multiplyScalar(r * 0.94));
    m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), nd);
    group.add(m);
  }
  let modelGroup = new THREE.Group();
  scene.add(modelGroup);
  let pickGroup = new THREE.Group(); scene.add(pickGroup);       // invisible click/drag proxies
  let highlightGroup = new THREE.Group(); scene.add(highlightGroup); // selection markers
  const pickMat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false });
  let lastState = { nodes: [], pipes: [], slabs: [] };
  let selId = null, selKind = null;

  function tube2(group, p1, p2, r, mat) { // like tube() but returns the mesh (for pick proxies / highlight)
    const d = new THREE.Vector3().subVectors(p2, p1), len = d.length();
    if (len < 1e-4) return null;
    const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, len, 10), mat);
    m.position.copy(p1).addScaledVector(d, 0.5);
    m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.clone().normalize());
    group.add(m); return m;
  }

  function update(state, keepCamera = false) {
    lastState = state;
    scene.remove(modelGroup);
    modelGroup = new THREE.Group();
    const byId = new Map(state.nodes.map((n) => [n.id, n]));

    // collect pipe ends per joint so we can draw real fittings (elbow / tee / coupling)
    const joints = new Map();
    const keyOf = (v) => `${v.x.toFixed(2)},${v.y.toFixed(2)},${v.z.toFixed(2)}`;
    const addEnd = (pos, dir, r, mat) => {
      const k = keyOf(pos);
      let g = joints.get(k);
      if (!g) { g = { pos: pos.clone(), r, mat, ends: [] }; joints.set(k, g); }
      g.r = Math.max(g.r, r);
      g.ends.push(dir.clone().normalize());
    };

    const pipeMat = (m) => (m === 'drainage' ? M.drain : m === 'vent' ? M.vent : m === 'power' ? M.power : m === 'air' ? M.air : M.ppr);
    const fitMat = (m) => (m === 'drainage' ? M.drain : m === 'vent' ? M.vent : m === 'power' ? M.power : m === 'air' ? M.air : M.fitting);
    const beam = (p1, p2, h, mat) => {
      const d = new THREE.Vector3().subVectors(p2, p1), len = d.length();
      if (len < 1e-4) return;
      const m = new THREE.Mesh(new THREE.BoxGeometry(len, h, h * 0.6), mat);
      m.position.copy(p1).addScaledVector(d, 0.5);
      m.quaternion.setFromUnitVectors(new THREE.Vector3(1, 0, 0), d.clone().normalize());
      m.castShadow = true; modelGroup.add(m);
    };
    for (const p of state.pipes) {
      const a = byId.get(p.from), b = byId.get(p.to);
      if (!a || !b) continue;
      const zf = hz(a), zt = hz(b);
      const wps = p.waypoints || [];
      // route: run through the bends at the FROM height, then drop to the TO height on the last leg
      const path = [V(a.x, zf, a.y), ...wps.map((w) => V(w.x, zf, w.y)), V(b.x, zt, b.y)];
      if (p.medium === 'beam') { for (let i = 0; i < path.length - 1; i++) beam(path[i], path[i + 1], (p.sizeOd ?? 400) / 1000, M.beam); continue; }
      const supply = p.medium === 'cold' || p.medium === 'hot';
      const r = p.medium === 'power' ? 0.05 : p.medium === 'air' ? Math.max(0.12, (p.sizeOd ?? 200) / 1000 / 2) : Math.max(0.045, (p.sizeOd ?? 20) / 1000 * (supply ? 1.9 : 1.0));
      for (let i = 0; i < path.length - 1; i++) {
        const q1 = path[i], q2 = path[i + 1];
        tube(modelGroup, q1, q2, r, pipeMat(p.medium));
        if (supply) stripe(modelGroup, q1, q2, r, p.medium === 'hot' ? M.stripeHot : M.stripeCold);
        const dir = new THREE.Vector3().subVectors(q2, q1);
        addEnd(q1, dir, r, fitMat(p.medium));            // fitting at each joint / bend
        addEnd(q2, dir.clone().negate(), r, fitMat(p.medium));
      }
    }

    // real fittings: an enlarged socket hugging each incoming pipe + a moulded rim + a corner body.
    // Two sockets at an angle read as an elbow; three read as a tee; two in line as a coupling.
    for (const g of joints.values()) {
      const body = new THREE.Mesh(new THREE.SphereGeometry(g.r * 1.18, 18, 18), g.mat);
      body.position.copy(g.pos); body.castShadow = true; modelGroup.add(body);
      for (const d of g.ends) {
        const L = g.r * 3.2, rs = g.r * 1.42;
        const socket = new THREE.Mesh(new THREE.CylinderGeometry(rs, rs, L, 20), g.mat);
        socket.position.copy(g.pos).addScaledVector(d, L * 0.42);
        socket.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), d);
        socket.castShadow = true; modelGroup.add(socket);
        const rim = new THREE.Mesh(new THREE.TorusGeometry(rs, rs * 0.2, 10, 22), g.mat);
        rim.position.copy(g.pos).addScaledVector(d, L * 0.82);
        rim.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), d);
        rim.castShadow = true; modelGroup.add(rim);
      }
    }

    for (const n of state.nodes) {
      const z = hz(n);
      const ng = new THREE.Group(); // per-node group so the whole component can be rotated
      if (n.kind === 'fixture') {
        const box = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.55, 0.5), M.fixture);
        box.position.set(n.x, 0.3, n.y); box.castShadow = true; box.receiveShadow = true; ng.add(box);
        const br = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.075, 0.13, 16), M.brass); // brass transition
        br.position.set(n.x, z, n.y); br.castShadow = true; ng.add(br);
        if (z > 0.62) tube(ng, V(n.x, z, n.y), V(n.x, 0.55, n.y), 0.05, M.ppr); // drop to the fixture
      } else if (n.kind === 'source') {
        const tank = new THREE.Mesh(new THREE.CylinderGeometry(0.62, 0.62, 2.0, 24), M.tank);
        tank.position.set(n.x, 1.0, n.y); tank.castShadow = true; ng.add(tank);
        const lid = new THREE.Mesh(new THREE.CylinderGeometry(0.66, 0.66, 0.1, 24), M.tank);
        lid.position.set(n.x, 2.05, n.y); ng.add(lid);
      } else if (n.kind === 'outlet') {
        const man = new THREE.Mesh(new THREE.CylinderGeometry(0.44, 0.44, 0.36, 20), M.outlet);
        man.position.set(n.x, 0.18, n.y); man.castShadow = true; man.receiveShadow = true; ng.add(man);
      } else if (n.kind === 'vent-terminal') {
        const stub = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.5, 14), M.vent);
        stub.position.set(n.x, z + 0.25, n.y); stub.castShadow = true; ng.add(stub);
        const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 0.08, 14), M.vent);
        cap.position.set(n.x, z + 0.5, n.y); ng.add(cap);
      } else if (n.kind === 'panel') {
        const cab = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.7, 0.18), M.panel);
        cab.position.set(n.x, z, n.y); cab.castShadow = true; ng.add(cab);
      } else if (n.kind === 'load') {
        const box = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.22, 0.1), M.power);
        box.position.set(n.x, z, n.y); box.castShadow = true; ng.add(box);
      } else if (n.kind === 'ahu') {
        const unit = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.7, 0.7), M.panel);
        unit.position.set(n.x, z, n.y); unit.castShadow = true; ng.add(unit);
      } else if (n.kind === 'diffuser') {
        const grille = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.08, 0.4), M.air);
        grille.position.set(n.x, z, n.y); grille.castShadow = true; ng.add(grille);
      } else if (n.kind === 'support') {
        const w = n.column && n.column.size != null ? n.column.size / 1000 : 0.3; // real section (m)
        const H = Math.min(30, Math.max(1, n.floorsSupported || 1) * 3.0); // taller if it carries more floors
        const col = new THREE.Mesh(new THREE.BoxGeometry(w, H, w), M.beam);
        col.position.set(n.x, H / 2, n.y); col.castShadow = true; col.receiveShadow = true; ng.add(col);
      } else if (n.kind === 'fitting') {
        const parts = String(n.fixtureType || 'coupling').split('|');
        const ft = parts[0], od = Number(parts[1]) || 50;
        const R = Math.max(0.045, (od / 1000) * 1.0), S = R * 2.4 + 0.06; // size the model by the fitting Ø

        const P = (dx, dz) => V(n.x + dx * S, z, n.y + dz * S), C = V(n.x, z, n.y);
        const hub = (r, mat) => { const s = new THREE.Mesh(new THREE.SphereGeometry(r || R * 1.4, 14, 14), mat || M.fitting); s.position.set(n.x, z, n.y); s.castShadow = true; ng.add(s); };
        const cyl = (r1, r2, len, mat) => { const m = new THREE.Mesh(new THREE.CylinderGeometry(r1, r2, len, 16), mat); m.position.set(n.x, z, n.y); m.rotation.z = Math.PI / 2; m.castShadow = true; ng.add(m); };
        if (ft === 'elbow90') { tube(ng, C, P(-1, 0), R, M.ppr); tube(ng, C, P(0, -1), R, M.ppr); hub(); }
        else if (ft === 'elbow45') { tube(ng, C, P(-1, 0), R, M.ppr); tube(ng, C, P(0.7, -0.7), R, M.ppr); hub(); }
        else if (ft === 'tee') { tube(ng, P(-1, 0), P(1, 0), R, M.ppr); tube(ng, C, P(0, 1), R, M.ppr); hub(); }
        else if (ft === 'cross') { tube(ng, P(-1, 0), P(1, 0), R, M.ppr); tube(ng, P(0, -1), P(0, 1), R, M.ppr); hub(); }
        else if (ft === 'reducer') { cyl(R * 1.5, R * 0.7, S * 1.7, M.ppr); }
        else if (ft === 'union') { cyl(R * 1.2, R * 1.2, S * 1.7, M.ppr); const nut = new THREE.Mesh(new THREE.CylinderGeometry(R * 1.8, R * 1.8, 0.06, 6), M.brass); nut.position.set(n.x, z, n.y); nut.rotation.z = Math.PI / 2; ng.add(nut); }
        else if (ft === 'transition') { cyl(R * 1.2, R * 1.2, S * 1.4, M.ppr); const ring = new THREE.Mesh(new THREE.CylinderGeometry(R * 1.5, R * 1.5, 0.06, 16), M.brass); ring.position.set(n.x + S * 0.5, z, n.y); ring.rotation.z = Math.PI / 2; ng.add(ring); }
        else if (ft === 'endcap') { tube(ng, P(-1, 0), C, R, M.ppr); const cap = new THREE.Mesh(new THREE.SphereGeometry(R, 14, 14, 0, Math.PI * 2, 0, Math.PI / 2), M.ppr); cap.position.set(n.x, z, n.y); cap.rotation.z = -Math.PI / 2; ng.add(cap); }
        else if (ft === 'valve') {
          const c1 = new THREE.Mesh(new THREE.CylinderGeometry(R * 1.7, R * 0.35, S, 16), M.ppr); c1.position.set(n.x - S * 0.5, z, n.y); c1.rotation.z = Math.PI / 2; ng.add(c1);
          const c2 = new THREE.Mesh(new THREE.CylinderGeometry(R * 0.35, R * 1.7, S, 16), M.ppr); c2.position.set(n.x + S * 0.5, z, n.y); c2.rotation.z = Math.PI / 2; ng.add(c2);
          const stem = new THREE.Mesh(new THREE.CylinderGeometry(R * 0.3, R * 0.3, S, 8), M.brass); stem.position.set(n.x, z + S * 0.5, n.y); ng.add(stem);
          const wheel = new THREE.Mesh(new THREE.TorusGeometry(R * 1.1, R * 0.25, 8, 18), M.brass); wheel.position.set(n.x, z + S, n.y); wheel.rotation.x = Math.PI / 2; ng.add(wheel);
        } else { cyl(R * 1.2, R * 1.2, S * 1.7, M.ppr); } // coupling / default
      }
      // pivot the group at the node so a rotation spins the component in place
      if (ng.children.length) {
        const pivot = new THREE.Vector3(n.x, 0, n.y);
        ng.children.forEach((m) => m.position.sub(pivot));
        ng.position.copy(pivot);
        ng.rotation.y = -((n.rotationDeg || 0) * Math.PI) / 180;
        modelGroup.add(ng);
      }
    }
    for (const sl of state.slabs || []) {
      const cs = sl.corners.map((id) => state.nodes.find((n) => n.id === id)).filter(Boolean);
      if (cs.length < 3 || sl.thickness == null) continue;
      const shape = new THREE.Shape();
      shape.moveTo(cs[0].x, cs[0].y);
      for (let i = 1; i < cs.length; i++) shape.lineTo(cs[i].x, cs[i].y);
      shape.closePath();
      const th = sl.thickness / 1000;
      const slab = new THREE.Mesh(new THREE.ExtrudeGeometry(shape, { depth: th, bevelEnabled: false }), M.beam);
      slab.rotation.x = Math.PI / 2; // lay the panel flat: plan (x,y) → world (x,z)
      slab.position.y = 0.15; // sit at floor level
      slab.receiveShadow = true; slab.castShadow = true;
      modelGroup.add(slab);
    }
    scene.add(modelGroup);

    // invisible pick proxies (a sphere per node, fat cylinders along each pipe) — the raycast targets
    scene.remove(pickGroup); pickGroup = new THREE.Group();
    for (const n of state.nodes) {
      const s = new THREE.Mesh(new THREE.SphereGeometry(0.6, 10, 10), pickMat);
      s.position.set(n.x, hz(n), n.y); s.userData = { pick: 'node', id: n.id }; pickGroup.add(s);
    }
    for (const p of state.pipes) {
      const a = byId.get(p.from), b = byId.get(p.to); if (!a || !b) continue;
      const path = [V(a.x, hz(a), a.y), ...(p.waypoints || []).map((w) => V(w.x, hz(a), w.y)), V(b.x, hz(b), b.y)];
      for (let i = 0; i < path.length - 1; i++) { const c = tube2(pickGroup, path[i], path[i + 1], 0.28, pickMat); if (c) c.userData = { pick: 'pipe', id: p.id }; }
    }
    scene.add(pickGroup);
    applyHighlight();

    if (state.nodes.length && !keepCamera) {
      const xs = state.nodes.map((n) => n.x), zs = state.nodes.map((n) => n.y);
      controls.target.set((Math.min(...xs) + Math.max(...xs)) / 2, 1, (Math.min(...zs) + Math.max(...zs)) / 2);
    }
  }

  // ---- selection highlight (a gold ring on nodes, bright overlay tubes on pipes) ----
  function applyHighlight() {
    scene.remove(highlightGroup); highlightGroup = new THREE.Group();
    const hlMat = new THREE.MeshBasicMaterial({ color: 0xffb300, transparent: true, opacity: 0.6, depthTest: false });
    const byId = new Map(lastState.nodes.map((n) => [n.id, n]));
    if (selKind === 'node') {
      const n = byId.get(selId);
      if (n) { const ring = new THREE.Mesh(new THREE.TorusGeometry(0.72, 0.07, 10, 26), hlMat); ring.rotation.x = Math.PI / 2; ring.position.set(n.x, hz(n), n.y); ring.renderOrder = 999; highlightGroup.add(ring); }
    } else if (selKind === 'pipe') {
      const p = lastState.pipes.find((x) => x.id === selId), a = p && byId.get(p.from), b = p && byId.get(p.to);
      if (p && a && b) {
        const path = [V(a.x, hz(a), a.y), ...(p.waypoints || []).map((w) => V(w.x, hz(a), w.y)), V(b.x, hz(b), b.y)];
        for (let i = 0; i < path.length - 1; i++) { const m = tube2(highlightGroup, path[i], path[i + 1], 0.09, hlMat); if (m) m.renderOrder = 999; }
      }
    }
    scene.add(highlightGroup);
  }
  function select(id, kind) { selId = id; selKind = kind; applyHighlight(); }

  let running = true;
  (function animate() { if (!running) return; controls.update(); renderer.render(scene, camera); requestAnimationFrame(animate); })();

  function resize() {
    const w = container.clientWidth || 800, h = container.clientHeight || 500;
    renderer.setSize(w, h, false);
    camera.aspect = w / h; camera.updateProjectionMatrix();
  }
  resize();

  // reference model (e.g. an imported IFC building) shown translucent to coordinate MEP against
  let refGroup = null;
  function clearReference() { if (refGroup) { scene.remove(refGroup); refGroup = null; } }
  function setReference(group) {
    clearReference();
    refGroup = group;
    group.rotation.x = -Math.PI / 2; // IFC Z-up → three Y-up
    scene.add(group);
    const box = new THREE.Box3().setFromObject(group);
    if (!Number.isFinite(box.min.x)) return;
    const size = box.getSize(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z) || 1;
    group.scale.multiplyScalar(24 / maxDim);
    const b2 = new THREE.Box3().setFromObject(group);
    const c = b2.getCenter(new THREE.Vector3());
    group.position.x += 13 - c.x;
    group.position.z += 7.5 - c.z;
    group.position.y += -b2.min.y; // sit on the floor
    group.traverse((o) => { if (o.material) { o.material.transparent = true; o.material.opacity = Math.min(o.material.opacity ?? 1, 0.5); o.material.depthWrite = false; } });
  }

  // ---- interaction: click to select, drag a node across the floor ----
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  const dom = renderer.domElement;
  let down = null, dragging = null;
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  function setPointer(e) { const r = dom.getBoundingClientRect(); pointer.x = ((e.clientX - r.left) / r.width) * 2 - 1; pointer.y = -((e.clientY - r.top) / r.height) * 2 + 1; }
  function pick(e) {
    setPointer(e); raycaster.setFromCamera(pointer, camera);
    for (const h of raycaster.intersectObjects(pickGroup.children, false)) { const u = h.object.userData; if (u && u.pick) return { pick: u.pick, id: u.id, y: h.object.position.y }; }
    return null;
  }
  function planeHit(e, y) {
    setPointer(e); raycaster.setFromCamera(pointer, camera);
    const t = new THREE.Vector3();
    return raycaster.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), -y), t) ? t : null;
  }
  function liveMove(id, x, z) {
    const temp = { ...lastState, nodes: lastState.nodes.map((n) => (n.id === id ? { ...n, x, y: z } : n)) };
    update(temp, true); // keep camera; rebuild so pipes follow the dragged node
  }
  dom.addEventListener('pointerdown', (e) => {
    const hit = pick(e);
    down = { x: e.clientX, y: e.clientY, hit, moved: false };
    const canDrag = opts.canDragNode ? opts.canDragNode() : true;
    if (hit && hit.pick === 'node' && canDrag) {
      controls.enabled = false; dragging = { id: hit.id, planeY: hit.y, x: null, z: null, ptr: e.pointerId };
      try { dom.setPointerCapture(e.pointerId); } catch { /* ignore */ }
      select('node', hit.id); opts.onSelect && opts.onSelect('node', hit.id); // reflect the grab immediately
    }
  }, true); // capture phase so we can disable OrbitControls before it starts an orbit
  dom.addEventListener('pointermove', (e) => {
    if (!down) return;
    if (Math.hypot(e.clientX - down.x, e.clientY - down.y) > 3) down.moved = true;
    if (dragging) { const pt = planeHit(e, dragging.planeY); if (pt) { dragging.x = clamp(pt.x, 0.5, 25.5); dragging.z = clamp(pt.z, 0.5, 14.5); liveMove(dragging.id, dragging.x, dragging.z); } }
  });
  function endPointer(e) {
    if (dragging) {
      controls.enabled = true;
      try { if (e && dragging.ptr != null) dom.releasePointerCapture(dragging.ptr); } catch { /* ignore */ }
      if (down && down.moved && dragging.x != null) opts.onNodeMoved && opts.onNodeMoved(dragging.id, dragging.x, dragging.z);
      dragging = null; down = null; return;
    }
    if (down) {
      if (!down.moved) { // a click (not an orbit) → let the app apply the current tool
        const world = e ? planeHit(e, 0) : null;
        if (opts.onClick) opts.onClick(down.hit || null, world ? { x: world.x, z: world.z } : null);
        else if (opts.onSelect) opts.onSelect(down.hit ? down.hit.pick : null, down.hit ? down.hit.id : null);
      }
      down = null;
    }
  }
  dom.addEventListener('pointerup', endPointer);
  dom.addEventListener('pointercancel', endPointer);

  // world floor point (x, z) under a screen coordinate — used to place dropped/palette items in 3D
  function floorPointAt(cx, cy) { const pt = planeHit({ clientX: cx, clientY: cy }, 0); return pt ? { x: pt.x, z: pt.z } : null; }

  return { update, resize, select, floorPointAt, setReference, clearReference, dispose() { running = false; renderer.dispose(); container.innerHTML = ''; } };
}
