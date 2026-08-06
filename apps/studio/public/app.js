// BuildGraph Studio — interactive canvas with professional 2D symbols, CAD & schematic styles,
// and a 3D view. Vanilla JS. It draws the model and sends LayoutEvents to the backend, which runs
// the real engine and returns fresh state.

const $ = (id) => document.getElementById(id);
const svg = $('canvas');
const WORLD = { w: 26, h: 15 }; // metres (matches viewBox)

/**
 * HTML-escape every dynamic value on its way into markup.
 *
 * The server already refuses markup in identifiers, fixture types and product names, so this is the
 * second lock rather than the only one — and it has to be, because a workspace is shared: a value
 * rendered here may have been typed by a collaborator. Escaping numbers too costs nothing and
 * removes the need to remember which fields happen to be numeric.
 */
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
/** Escaped, or an em dash when there is nothing to show. */
const escOr = (value, fallback = '—') => (value === null || value === undefined || value === '' ? fallback : esc(value));

const FIXTURE_LABEL = { WaterCloset: 'Water Closet', Lavatory: 'Lavatory', KitchenSink: 'Kitchen Sink', Shower: 'Shower', Bathtub: 'Bathtub', WashingMachine: 'Washing Machine', HoseBibb: 'Hose Bibb' };
const TAG = { WaterCloset: 'WC-1', Lavatory: 'LAV-1', KitchenSink: 'KS-1', Shower: 'SH-1', Bathtub: 'BT-1', WashingMachine: 'WM-1', HoseBibb: 'HB-1' };

let current = { nodes: [], pipes: [], slabs: [], boq: [], log: [], fixtureTypes: [], meta: {} };
let slabCorners = []; // node ids collected while drawing a slab polygon
let tool = 'select';
let viewMode = 'schematic'; // 'schematic' | 'cad' | '3d'
let pressureMode = false;   // pressure map: highlight the critical path + tag fixture residuals
let pipeMedium = 'cold';
let selId = null, selKind = null;
let pendingFrom = null;
let underlay = null;      // raster underlay (image/PDF snapshot) to trace
let planUnderlay = null;  // vector floor plan derived from an imported IFC (section cut)
let ifcMesh = null;       // cached world-space triangle soup, so the cut height can be re-sliced live
let ifcFileName = '';
let aiEnabled = false;    // true when the server has an ANTHROPIC_API_KEY (live AI copilot)
let drag = null;
let three = null;
let account = null;             // the signed-in user, once /api/auth/me confirms a session
let authMode = 'accounts';      // 'open' when the server runs as a single-user local tool
let allowRegistration = false;
let workspaces = [];            // every workspace this account can open
let activeWorkspaceId = null;   // the one currently on screen
const clientId = 'c_' + Math.random().toString(36).slice(2, 10); // identifies THIS tab (suppresses echo of own edits)
let pendingRemote = null; // latest collaborator state waiting to be applied (deferred while dragging)

/* ---------- API ---------- */
async function api(path, method = 'GET', body) {
  const headers = { 'x-client-id': clientId };
  if (activeWorkspaceId) headers['x-workspace'] = activeWorkspaceId;
  if (body !== undefined) headers['content-type'] = 'application/json';

  const res = await fetch(path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: 'same-origin',
  });

  let data = null;
  try { data = await res.json(); } catch { /* an error page, or an empty body */ }

  // A session that expired mid-edit should put the sign-in card back, not surface as a stray error.
  if (res.status === 401 && authMode === 'accounts') {
    openAuthGate('Your session ended. Sign in to continue.');
    throw new Error('signed out');
  }
  if (!res.ok) throw new Error((data && data.error) || `Request failed (${res.status})`);
  return data;
}
/** Download and report links are opened as navigations, so the workspace travels as a query. */
const withWorkspace = (path) => (activeWorkspaceId ? `${path}${path.includes('?') ? '&' : '?'}workspace=${encodeURIComponent(activeWorkspaceId)}` : path);
function status(m) { $('status').textContent = m; }
async function guarded(label, fn) { try { status(label + '…'); const r = await fn(); status(label + ' ✓'); return r; } catch (e) { status('error: ' + e.message); } }
const command = (events) => api('/api/command', 'POST', events).then(render);
const uid = (p) => p + (crypto.randomUUID ? crypto.randomUUID().slice(0, 8) : Date.now().toString(36) + Math.random().toString(36).slice(2, 6));

/* ---------- geometry ---------- */
function toModel(cx, cy) { const pt = svg.createSVGPoint(); pt.x = cx; pt.y = cy; const p = pt.matrixTransform(svg.getScreenCTM().inverse()); return { x: p.x, y: p.y }; }
const snap = (v) => Math.round(v / 0.25) * 0.25;
const clampX = (x) => Math.max(0.5, Math.min(WORLD.w - 0.5, x));
const clampY = (y) => Math.max(0.5, Math.min(WORLD.h - 0.5, y));
const nodeById = (id) => current.nodes.find((n) => n.id === id);
const pipeWidthM = (od) => Math.max(0.1, Math.min(0.34, (od / 1000) * 3.4));
const symHalf = (n) => (n.kind === 'source' || n.kind === 'outlet' || n.kind === 'vent-terminal' || n.kind === 'panel' || n.kind === 'ahu') ? 0.55 : (n.kind === 'junction' || n.kind === 'support') ? 0.22 : n.kind === 'fitting' ? 0.3 * fitScale(parseFit(n.fixtureType).od) : (n.kind === 'load' || n.kind === 'diffuser') ? 0.3 : ({ WaterCloset: 0.46, Lavatory: 0.3, Shower: 0.5, Bathtub: 0.85, KitchenSink: 0.32, WashingMachine: 0.34, HoseBibb: 0.16 }[n.fixtureType] ?? 0.3);
const MEDIA = ['cold', 'hot', 'drainage', 'vent', 'power', 'air', 'beam'];
const CAT_FIX = { 'Water Closet': 'WaterCloset', 'Lavatory': 'Lavatory', 'Shower': 'Shower', 'Bathtub': 'Bathtub', 'Kitchen Sink': 'KitchenSink', 'Washing Machine Outlet': 'WashingMachine', 'Hose Bibb': 'HoseBibb' };
let placing = null; // pending catalog placement { kind, fixtureType? }
let activePipeProduct = null; // catalog pipe product applied to newly drawn pipes

/* ---------- fitting symbols (plan view, per type) ---------- */
function fittingSymbol(raw) {
  const { type, od } = parseFit(raw);
  const s = fitScale(od);
  return `<g transform="scale(${s.toFixed(3)})">${fittingGlyph(type)}</g>`;
}
function fittingGlyph(code) {
  switch (code) {
    case 'elbow90': return `<g class="sym"><path d="M-0.3 0.12 L0.12 0.12 L0.12 -0.3"/><circle r="0.1" class="fill"/></g>`;
    case 'elbow45': return `<g class="sym"><path d="M-0.3 0.1 L0.1 0.1 L0.3 -0.22"/><circle r="0.1" class="fill"/></g>`;
    case 'tee': return `<g class="sym"><path d="M-0.3 -0.1 H0.3 M0 -0.1 V0.3"/><circle r="0.1" class="fill"/></g>`;
    case 'cross': return `<g class="sym"><path d="M-0.3 0 H0.3 M0 -0.3 V0.3"/><circle r="0.1" class="fill"/></g>`;
    case 'reducer': return `<g class="sym"><path d="M-0.28 -0.2 L0.28 -0.09 L0.28 0.09 L-0.28 0.2 Z"/></g>`;
    case 'union': return `<g class="sym"><rect x="-0.28" y="-0.13" width="0.56" height="0.26" rx="0.04"/><path d="M0 -0.22 l0.19 0.11 v0.22 l-0.19 0.11 l-0.19 -0.11 v-0.22 Z" class="thin"/></g>`;
    case 'endcap': return `<g class="sym"><path d="M-0.26 -0.16 H0.04 a0.16 0.16 0 0 1 0 0.32 H-0.26 Z"/></g>`;
    case 'transition': return `<g class="sym"><rect x="-0.28" y="-0.13" width="0.56" height="0.26" rx="0.04"/><rect x="-0.06" y="-0.13" width="0.12" height="0.26" class="fill"/></g>`;
    case 'valve': return `<g class="sym"><path d="M-0.28 -0.2 L0 0 L-0.28 0.2 Z"/><path d="M0.28 -0.2 L0 0 L0.28 0.2 Z"/><path d="M0 0 V-0.3 M-0.13 -0.3 H0.13" class="thin"/></g>`;
    default: return `<g class="sym"><rect x="-0.28" y="-0.14" width="0.56" height="0.28" rx="0.04"/><path d="M-0.1 -0.14 V0.14 M0.1 -0.14 V0.14" class="thin"/></g>`; // coupling
  }
}
/* ---------- fixture / node symbols (plan view, metres, centred) ---------- */
function symbolInner(n) {
  if (n.kind === 'source') return `<g class="sym"><circle r="0.5"/><circle r="0.36" class="thin"/><path d="M0 -0.5V0.5M-0.5 0H0.5" class="thin"/></g>`;
  if (n.kind === 'outlet') return `<g class="sym"><circle r="0.46"/><circle r="0.3" class="thin"/><path d="M-0.32 -0.32L0.32 0.32M0.32 -0.32L-0.32 0.32" class="thin"/></g>`;
  if (n.kind === 'vent-terminal') return `<g class="sym"><circle r="0.44"/><path d="M0 -0.44V0.44M-0.28 -0.2L0 -0.44L0.28 -0.2" class="thin"/></g>`;
  if (n.kind === 'panel') return `<g class="sym"><rect x="-0.4" y="-0.52" width="0.8" height="1.04" rx="0.04"/><path d="M-0.4 -0.18H0.4M-0.4 0.14H0.4" class="thin"/></g>`;
  if (n.kind === 'load') return `<g class="sym"><circle r="0.28"/><path d="M-0.13 0H0.13M0 -0.13V0.13" class="thin"/></g>`;
  if (n.kind === 'ahu') return `<g class="sym"><rect x="-0.5" y="-0.4" width="1.0" height="0.8" rx="0.04"/><path d="M-0.5 0H0.5M-0.16 -0.4V0.4M0.16 -0.4V0.4" class="thin"/></g>`;
  if (n.kind === 'diffuser') return `<g class="sym"><rect x="-0.3" y="-0.3" width="0.6" height="0.6" rx="0.03"/><path d="M-0.3 -0.3L0.3 0.3M0.3 -0.3L-0.3 0.3" class="thin"/></g>`;
  if (n.kind === 'support') return `<g class="sym"><rect x="-0.18" y="-0.18" width="0.36" height="0.36"/><path d="M-0.18 0.18L0 0.02L0.18 0.18" class="thin"/></g>`;
  if (n.kind === 'junction') return `<g class="sym"><circle r="0.13" class="fill"/></g>`;
  if (n.kind === 'fitting') return fittingSymbol(n.fixtureType);
  switch (n.fixtureType) {
    case 'WaterCloset': return `<g class="sym"><rect x="-0.28" y="-0.44" width="0.56" height="0.2" rx="0.03"/><ellipse cx="0" cy="0.04" rx="0.24" ry="0.34"/><ellipse cx="0" cy="0.04" rx="0.14" ry="0.22" class="thin"/></g>`;
    case 'Lavatory': return `<g class="sym"><rect x="-0.32" y="-0.24" width="0.64" height="0.48" rx="0.09"/><ellipse cx="0" cy="0.03" rx="0.22" ry="0.14" class="thin"/><circle cx="0" cy="-0.16" r="0.03" class="fill"/></g>`;
    case 'Shower': return `<g class="sym"><rect x="-0.45" y="-0.45" width="0.9" height="0.9" rx="0.03"/><path d="M-0.45 -0.45L0.45 0.45M0.45 -0.45L-0.45 0.45" class="thin"/><circle r="0.06" class="fill"/></g>`;
    case 'Bathtub': return `<g class="sym"><rect x="-0.36" y="-0.8" width="0.72" height="1.6" rx="0.14"/><rect x="-0.27" y="-0.66" width="0.54" height="1.3" rx="0.11" class="thin"/><circle cx="0" cy="0.62" r="0.05" class="fill"/></g>`;
    case 'KitchenSink': return `<g class="sym"><rect x="-0.42" y="-0.28" width="0.84" height="0.56" rx="0.04"/><rect x="-0.36" y="-0.22" width="0.34" height="0.44" rx="0.04" class="thin"/><rect x="0.02" y="-0.22" width="0.34" height="0.44" rx="0.04" class="thin"/></g>`;
    case 'WashingMachine': return `<g class="sym"><rect x="-0.32" y="-0.32" width="0.64" height="0.64" rx="0.04"/><circle cx="0" cy="0.02" r="0.21"/><circle cx="0" cy="0.02" r="0.1" class="thin"/></g>`;
    case 'HoseBibb': return `<g class="sym"><circle r="0.12"/><line x1="0" y1="0" x2="0.24" y2="0"/></g>`;
    default: return `<g class="sym"><rect x="-0.2" y="-0.2" width="0.4" height="0.4" rx="0.04"/></g>`;
  }
}
function nodeMarkup(n) {
  const sel = selId === n.id ? 'sel' : '', pending = pendingFrom === n.id ? 'pending' : '';
  const tag = n.kind === 'fixture' ? (TAG[n.fixtureType] ?? 'FIX') : n.kind === 'source' ? 'TANK' : n.kind === 'outlet' ? 'SEWER' : n.kind === 'vent-terminal' ? 'VENT' : n.kind === 'panel' ? 'DB' : n.kind === 'ahu' ? 'AHU' : n.kind === 'support' && n.column && n.column.size != null ? `${n.column.size}×${n.column.size}` : '';
  const h = symHalf(n);
  const label = tag ? `<text class="node-tag" x="0" y="${(h + 0.34).toFixed(2)}" text-anchor="middle">${esc(tag)}</text>` : '';
  const rot = n.rotationDeg ? ` transform="rotate(${n.rotationDeg})"` : '';
  // pressure map: residual-pressure chip on supply fixtures + the source
  let pchip = '';
  if (pressureMode && current.pressure && current.pressure.nodeResidual && (n.kind === 'fixture' || n.kind === 'source')) {
    const r = current.pressure.nodeResidual[n.id];
    if (r != null) {
      const min = current.pressure.minResidualKPa, max = current.pressure.maxPressureKPa;
      const cls = n.kind === 'source' ? 'src' : r < min ? 'bad' : r > max ? 'over' : 'ok';
      const chipY = n.y > 1.1 ? -h - 0.34 : h + 0.82; // flip below (clearing the tag) when too near the top edge
      pchip = `<g class="pchip ${cls}" transform="translate(0 ${chipY.toFixed(2)})"><rect x="-0.9" y="-0.28" width="1.8" height="0.5" rx="0.12"/><text x="0" y="0.1" text-anchor="middle">${r} kPa</text></g>`;
    }
  }
  // DWV fault marker: orphaned drain (red) or unvented trap (amber) — always shown, it's a validation error
  let dwvMark = '';
  if (n.kind === 'fixture' && current.dwv && current.dwv.active) {
    const orphan = (current.dwv.unconnectedDrains || []).includes(n.id);
    const unvented = !orphan && current.dwv.hasVentSystem && (current.dwv.unventedFixtures || []).includes(n.id);
    if (orphan || unvented) {
      const title = orphan ? 'No drainage path to the sewer' : 'Trap not vented — siphonage risk';
      dwvMark = `<g class="dwv-mark ${orphan ? 'orphan' : 'unvented'}" transform="translate(${(h * 0.72).toFixed(2)} ${(-h * 0.72).toFixed(2)})"><title>${esc(title)}</title><circle r="0.26"/><text x="0" y="0.11" text-anchor="middle">!</text></g>`;
    }
  }
  return `<g class="node ${esc(n.kind)} ${sel} ${pending}" data-node="${esc(n.id)}" transform="translate(${n.x} ${n.y})"><g${rot}>${symbolInner(n)}</g>${label}${pchip}${dwvMark}<circle class="node-hit" r="${(h + 0.12).toFixed(2)}"/></g>`;
}

/* ---------- pipes (routed polylines with elbow bends) ---------- */
// Move `from` toward `toward` by r, so a pipe end meets a component's edge instead of its centre.
function trimPoint(from, toward, r) {
  const dx = toward.x - from.x, dy = toward.y - from.y, d = Math.hypot(dx, dy) || 1;
  if (d <= r) return { x: from.x, y: from.y };
  return { x: from.x + (dx / d) * r, y: from.y + (dy / d) * r };
}
// The full routed point list [from, ...waypoints, to]; trimmed to the node symbol edges when trim=true.
function pipePoints(p, trim = true, posOverride = null) {
  const na = nodeById(p.from), nb = nodeById(p.to);
  if (!na || !nb) return null;
  const a = (posOverride && posOverride[p.from]) || na, b = (posOverride && posOverride[p.to]) || nb;
  const wps = (p.waypoints || []).map((w) => ({ x: w.x, y: w.y }));
  const pts = [{ x: a.x, y: a.y }, ...wps, { x: b.x, y: b.y }];
  if (trim && pts.length >= 2) {
    pts[0] = trimPoint(pts[0], pts[1], symHalf(na) + 0.03);
    pts[pts.length - 1] = trimPoint(pts[pts.length - 1], pts[pts.length - 2], symHalf(nb) + 0.03);
  }
  return pts;
}
const ptStr = (arr) => arr.map((q) => `${q.x.toFixed(3)},${q.y.toFixed(3)}`).join(' ');
// Two parallel offset polylines (±d) using vertex bisectors — the CAD double-line, bend-aware.
function offsetPolyline(pts, d) {
  const seg = [];
  for (let i = 0; i < pts.length - 1; i++) { const dx = pts[i + 1].x - pts[i].x, dy = pts[i + 1].y - pts[i].y, L = Math.hypot(dx, dy) || 1; seg.push({ x: -dy / L, y: dx / L }); }
  const side = (s) => pts.map((p, i) => {
    const nA = seg[Math.max(0, i - 1)], nB = seg[Math.min(seg.length - 1, i)];
    let mx = nA.x + nB.x, my = nA.y + nB.y; const ml = Math.hypot(mx, my) || 1; mx /= ml; my /= ml;
    const cos = Math.max(0.4, Math.abs(mx * nB.x + my * nB.y)); // miter length, capped
    return { x: p.x + s * mx * (d / cos), y: p.y + s * my * (d / cos) };
  });
  return { left: side(1), right: side(-1) };
}
function distToSeg(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y, L2 = dx * dx + dy * dy || 1e-9;
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / L2; t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}
// A vertical stack is drawn as a riser symbol (circle + dot) at its plan location, not a degenerate line.
function stackRiserMarkup(p) {
  const a = nodeById(p.from), b = nodeById(p.to);
  if (!a || !b) return '';
  const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2, r = 0.34;
  const sel = selId === p.id ? 'sel' : '';
  const fail = p.branchPass === false ? 'fail' : '';
  const floors = (p.stackFloors && p.stackFloors > 1) ? ` ×${p.stackFloors}` : '';
  const lbl = p.sizeOd != null ? `<text class="stack-label ${fail}" x="${(cx + r + 0.14).toFixed(2)}" y="${(cy + 0.12).toFixed(2)}">Ø${esc(p.sizeOd)}${esc(floors)}</text>` : '';
  return `<g class="stack-g ${sel} ${fail}" data-pipe="${esc(p.id)}">`
    + `<circle class="stack-ring" cx="${cx}" cy="${cy}" r="${r}"/>`
    + `<circle class="stack-dot" cx="${cx}" cy="${cy}" r="0.1"/>`
    + `<line class="stack-tick" x1="${(cx - r * 0.62).toFixed(2)}" y1="${cy.toFixed(2)}" x2="${(cx + r * 0.62).toFixed(2)}" y2="${cy.toFixed(2)}"/>`
    + `${lbl}<circle class="pipe-hit" data-pipe="${esc(p.id)}" cx="${cx}" cy="${cy}" r="${(r + 0.12).toFixed(2)}"/></g>`;
}
function pipeMarkup(p) {
  if (p.isStack) return ''; // stacks are drawn in a top layer (above nodes) so the riser is visible/clickable
  const pts = pipePoints(p), raw = pipePoints(p, false);
  if (!pts) return '';
  const w = pipeWidthM(p.sizeOd ?? 20);
  const fail = (p.sizePass === false || p.velocityPass === false) ? 'fail' : '';
  const sel = selId === p.id ? 'sel' : '';
  const crit = pressureMode && current.pressure && (current.pressure.criticalPipeIds || []).includes(p.id);
  const loop = pressureMode && current.recirc && current.recirc.active && (current.recirc.loopPipeIds || []).includes(p.id);
  let body;
  if (viewMode === 'cad') {
    const { left, right } = offsetPolyline(pts, w / 2);
    body = `<polyline points="${ptStr(left)}" class="pcad-edge ${fail}"/><polyline points="${ptStr(right)}" class="pcad-edge ${fail}"/><polyline points="${ptStr(pts)}" class="pcad-center"/>`;
  } else {
    body = `<polyline points="${ptStr(pts)}" class="pipe-outline ${esc(p.medium)} ${fail}" style="stroke-width:${(w + 0.055).toFixed(3)}"/>`
         + `<polyline points="${ptStr(pts)}" class="pipe-fill ${esc(p.medium)} ${fail}" style="stroke-width:${w.toFixed(3)}"/>`;
    for (let i = 1; i < pts.length - 1; i++) body += `<circle class="pipe-elbow ${esc(p.medium)} ${fail}" cx="${pts[i].x.toFixed(3)}" cy="${pts[i].y.toFixed(3)}" r="${(w * 0.62).toFixed(3)}"/>`;
  }
  // size label centred on the longest segment
  let bi = 0, best = -1;
  for (let i = 0; i < pts.length - 1; i++) { const L = Math.hypot(pts[i + 1].x - pts[i].x, pts[i + 1].y - pts[i].y); if (L > best) { best = L; bi = i; } }
  const mA = pts[bi], mB = pts[bi + 1], mx = (mA.x + mB.x) / 2, my = (mA.y + mB.y) / 2;
  let ang = Math.atan2(mB.y - mA.y, mB.x - mA.x) * 180 / Math.PI; if (ang > 90) ang -= 180; if (ang < -90) ang += 180;
  let label = '';
  if (p.sizeOd != null) {
    const sizeLabel = p.medium === 'power' ? `${esc(p.sizeOd)} mm²` : p.medium === 'beam' ? `${esc(p.sizeOd)}mm deep` : `Ø${esc(p.sizeOd)}mm`;
    label = `<text transform="translate(${mx.toFixed(3)} ${my.toFixed(3)}) rotate(${ang.toFixed(1)})" dy="${-(w / 2 + 0.12).toFixed(3)}" class="pipe-label ${fail}" text-anchor="middle">${sizeLabel}</text>`;
    if (p.medium === 'drainage' && p.slopePct != null) {
      label += `<text transform="translate(${mx.toFixed(3)} ${my.toFixed(3)}) rotate(${ang.toFixed(1)})" dy="${(w / 2 + 0.34).toFixed(3)}" class="pipe-label slope ${p.slopePass === false ? 'fail' : ''}" text-anchor="middle">SLOPE ${esc(p.slopePct)}%</text>`;
    }
  }
  const critLine = crit ? `<polyline points="${ptStr(pts)}" class="pipe-crit"/>` : (loop ? `<polyline points="${ptStr(pts)}" class="pipe-loop"/>` : '');
  const hit = `<polyline points="${ptStr(raw)}" class="pipe-hit" data-pipe="${esc(p.id)}"/>`;
  const handles = sel ? (p.waypoints || []).map((wp, i) => `<circle class="wp-handle" data-waypoint="${esc(p.id)}:${i}" cx="${wp.x.toFixed(3)}" cy="${wp.y.toFixed(3)}" r="0.15"/>`).join('') : '';
  return `<g class="pipe-g ${sel} ${crit ? 'crit' : ''}" data-pipe="${esc(p.id)}">${critLine}${body}${hit}${label}${handles}</g>`;
}

/* ---------- SVG render ---------- */
function gridMarkup() {
  let s = '<g class="grid">';
  for (let x = 0; x <= WORLD.w; x++) s += `<line x1="${x}" y1="0" x2="${x}" y2="${WORLD.h}" class="${x % 5 === 0 ? 'axis' : ''}"/>`;
  for (let y = 0; y <= WORLD.h; y++) s += `<line x1="0" y1="${y}" x2="${WORLD.w}" y2="${y}" class="${y % 5 === 0 ? 'axis' : ''}"/>`;
  return s + '</g>';
}
function underlayMarkup() {
  let out = '';
  if (underlay && underlay.visible && underlay.href) {
    out += `<image href="${underlay.href}" x="0" y="0" width="${WORLD.w}" height="${WORLD.h}" opacity="${underlay.opacity}" preserveAspectRatio="xMidYMid meet"/>`;
  }
  if (planUnderlay && planUnderlay.visible && planUnderlay.segments.length) {
    const lines = planUnderlay.segments
      .map((s) => `<line x1="${s.a.x.toFixed(3)}" y1="${s.a.y.toFixed(3)}" x2="${s.b.x.toFixed(3)}" y2="${s.b.y.toFixed(3)}"/>`)
      .join('');
    out += `<g class="ifc-plan" opacity="${planUnderlay.opacity}">${lines}</g>`;
  }
  return out;
}
function slabMarkup(sl) {
  const cs = sl.corners.map((id) => nodeById(id)).filter(Boolean);
  if (cs.length < 3) return '';
  const pts = cs.map((n) => `${n.x},${n.y}`).join(' ');
  const cx = cs.reduce((s, n) => s + n.x, 0) / cs.length, cy = cs.reduce((s, n) => s + n.y, 0) / cs.length;
  const sel = selKind === 'slab' && selId === sl.id ? 'sel' : '';
  const bad = sl.pass === false ? 'bad' : '';
  const label = sl.thickness != null ? `${esc(sl.thickness)}mm · ${esc(sl.type || 'slab')}` : 'slab —';
  return `<g class="slab-g ${sel} ${bad}" data-slab="${esc(sl.id)}"><polygon class="slab-face" points="${pts}"/><text class="slab-label" x="${cx.toFixed(2)}" y="${cy.toFixed(2)}" text-anchor="middle">${label}</text></g>`;
}
function pendingSlabMarkup() {
  if (tool !== 'slab' || slabCorners.length === 0) return '';
  const cs = slabCorners.map((id) => nodeById(id)).filter(Boolean);
  const line = cs.length ? `<polyline class="slab-pending" points="${cs.map((n) => `${n.x},${n.y}`).join(' ')}"/>` : '';
  const dots = cs.map((n) => `<circle class="slab-pending-dot" cx="${n.x}" cy="${n.y}" r="0.16"/>`).join('');
  return line + dots;
}
function renderSVG() {
  svg.setAttribute('class', 'mode-' + viewMode);
  svg.innerHTML = underlayMarkup() + gridMarkup()
    + `<g class="slabs">${(current.slabs || []).map(slabMarkup).join('')}${pendingSlabMarkup()}</g>`
    + `<g class="pipes">${current.pipes.map(pipeMarkup).join('')}</g>`
    + `<g class="nodes">${current.nodes.map(nodeMarkup).join('')}</g>`
    + `<g class="stacks">${current.pipes.filter((p) => p.isStack).map(stackRiserMarkup).join('')}</g>`;
}

function render(state) {
  if (state) current = state;
  renderPanels();
  if (viewMode === '3d') {
    svg.style.display = 'none'; $('view3d').hidden = false;
    if (three) { three.update(current); if (three.select) three.select(selId, selKind); }
  } else {
    $('view3d').hidden = true; svg.style.display = 'block';
    renderSVG();
  }
}

/* ---------- panels ---------- */
function renderPanels() {
  const s = current;
  $('undo').disabled = !s.canUndo; $('redo').disabled = !s.canRedo;
  $('jurisdiction').textContent = s.jurisdiction ?? '—';
  populatePalette(s.fixtureTypes);
  renderInspector(); renderHydraulics(); renderDwv(); renderBoq(); renderLog();
}
function renderDwv() {
  const el = $('dwv');
  const d = current.dwv;
  if (!d || !d.active) {
    el.innerHTML = `<p class="hint" style="margin:0">Place a <b>Sewer / Outlet</b> and connect fixtures with drainage pipe. This checks every fixture reaches the sewer and every trap is vented.</p>`;
    return;
  }
  const okBadge = (ok, good, bad) => `<span class="badge ${ok ? 'ok' : 'bad'}">${ok ? good : bad}</span>`;
  const label = (id) => { const n = nodeById(id); const t = n && n.fixtureType; return (FIXTURE_LABEL[t] || t || id); };
  const issues = [];
  for (const id of (d.unconnectedDrains || [])) issues.push(`<div class="prow bad"><span>${esc(label(id))} <span class="hint" style="margin:0">(${esc(id)})</span></span><b>no drain path</b></div>`);
  for (const id of (d.unventedFixtures || [])) issues.push(`<div class="prow over"><span>${esc(label(id))} <span class="hint" style="margin:0">(${esc(id)})</span></span><b>unvented trap</b></div>`);
  el.innerHTML = `
    <div class="cards">
      <div class="stat big"><span class="k">System load</span><span class="v">${esc(d.totalDfu)}</span><span class="k">DFU to sewer</span></div>
      <div class="stat"><span class="k">Drainage</span><span class="v" style="font-size:14px">${d.allDrained ? 'connected' : esc(d.unconnectedDrains.length) + ' orphan'}</span> ${okBadge(d.allDrained, 'all reach sewer', 'orphaned')}</div>
      <div class="stat"><span class="k">Venting</span><span class="v" style="font-size:14px">${!d.hasVentSystem ? 'none' : d.allVented ? 'complete' : esc(d.unventedFixtures.length) + ' open'}</span> ${okBadge(d.hasVentSystem && d.allVented, 'traps protected', d.hasVentSystem ? 'gaps' : 'no vents')}</div>
    </div>
    ${issues.length ? `<div class="plist">${issues.join('')}</div>` : '<p class="hint" style="margin-top:8px">✓ Every fixture drains to the sewer and every trap is vented.</p>'}`;
}
function renderInspector() {
  const box = $('selection');
  if (selKind === 'pipe') {
    const p = current.pipes.find((x) => x.id === selId);
    if (!p) return void (box.innerHTML = '<h2>Inspector</h2><p class="hint">Select a pipe or fixture.</p>');
    const traceHtml = `<h3>Sizing trace</h3><ol class="trace">${p.sizeSteps.map((st) => { const ok = /≤|pass|selected/.test(st.result); return `<li>${esc(st.expr)} <span class="${ok ? 'pass' : 'fail'}">→ ${esc(st.result)}</span></li>`; }).join('')}</ol><p class="clause">Clause: ${esc(p.clause)}</p>`;
    const sysKey = p.medium === 'drainage' ? 'drainage' : p.medium === 'vent' ? 'vent' : p.medium === 'power' ? 'power' : p.medium === 'air' ? 'air' : p.medium === 'beam' ? 'structure' : 'supply';
    const opts = current.sizeOptions?.[sysKey] || [];
    const unit = p.medium === 'power' ? ' mm²' : 'mm';
    const pre = (p.medium === 'power' || p.medium === 'beam') ? '' : 'Ø';
    const autoBy = p.medium === 'power' ? 'load' : p.medium === 'air' ? 'airflow' : p.medium === 'beam' ? 'span & load' : (p.medium === 'drainage' || p.medium === 'vent') ? 'DFU' : 'demand';
    const sizeCtl = `<label class="hint" style="display:block;margin-top:10px">Size ${p.manualOd != null ? '<span class="badge ok">manual</span>' : '<span class="badge">auto</span>'}<br/><select id="sizeSel" style="width:100%;margin-top:4px;padding:6px;border-radius:7px;border:1px solid var(--line)"><option value="">Auto (by ${esc(autoBy)})</option>${opts.map((od) => `<option value="${esc(od)}" ${p.manualOd === od ? 'selected' : ''}>${pre}${esc(od)}${unit}</option>`).join('')}</select></label>`;
    const prodInfo = p.product ? `<p class="hint" style="margin-top:8px">Product: <b>${esc(p.product.name)}</b> (${esc(p.product.material)})${p.product.price != null ? ' · $' + esc(p.product.price) + '/m' : ''}<br/><button id="clearProd" class="lib-place" style="margin-top:6px">Clear product (back to auto)</button></p>` : '';
    if (p.medium === 'drainage') {
      const isStack = p.isStack === true;
      const kindBadge = `<span class="badge ${isStack ? 'over' : 'ok'}">${isStack ? 'vertical stack' : 'horizontal branch/drain'}</span>`;
      const vb = isStack ? '' : (p.velocityPass == null ? '' : `<span class="badge ${p.velocityPass ? 'ok' : 'bad'}">${p.velocityPass ? 'self-cleansing' : 'too slow'}</span>`);
      const sb = isStack ? '' : (p.slopePass == null ? '' : `<span class="badge ${p.slopePass ? 'ok' : 'bad'}">${p.slopePass ? 'slope ok' : 'below min'}</span>`);
      const inS = 'width:100%;margin-top:4px;padding:6px;border-radius:7px;border:1px solid var(--line)';
      const bp = p.branchPass === false;
      const stackCtl = isStack
        ? `<label class="hint" style="display:block;margin-top:10px">Floors served (branch intervals)<br/><input id="floorsInput" type="number" min="1" step="1" value="${esc(p.stackFloors ?? 1)}" style="${inS}"/></label>
           <p class="hint" style="margin-top:6px">Per branch interval <b>${esc(p.perIntervalDfu ?? 0)} DFU</b> ${bp ? `<span class="badge bad">exceeds Ø${esc(p.sizeOd)} limit ${esc(p.branchLimit)}</span>` : `<span class="badge ok">≤ limit ${escOr(p.branchLimit)}</span>`}. Total <b>${esc(p.cumulativeDfu)} DFU</b> over ${esc(p.stackFloors ?? 1)} floor(s) sizes the stack; horizontal slope &amp; velocity do not apply.</p>`
        : `<label class="hint" style="display:block;margin-top:10px">Slope % ${sb}<br/><input id="slopeInput" type="number" min="0.5" step="0.5" value="${esc(p.slopePct)}" style="${inS}"/></label>`;
      const offsetNote = p.isOffset ? `<p class="hint warn" style="margin-top:8px;color:#b45309">⚠ Stack offset (jogs horizontally): size &amp; fixture-connection restrictions apply — verify per the offset rules.</p>` : '';
      box.innerHTML = `<h2>${isStack ? 'Drainage stack (vertical)' : p.isOffset ? 'Drainage offset' : 'Drain pipe (gravity)'}</h2>
        <p class="hint" style="margin:0 0 4px">${kindBadge}</p>
        <div class="cards">
          <div class="stat big"><span class="k">Size</span><span class="v">${p.sizeOd != null ? 'Ø' + esc(p.sizeOd) + 'mm' : '—'}</span></div>
          <div class="stat"><span class="k">DFU load</span><span class="v">${esc(p.cumulativeDfu)}</span></div>
          <div class="stat"><span class="k">Velocity</span><span class="v">${isStack ? '—' : escOr(p.velocityMs)}</span> ${vb}</div>
          <div class="stat"><span class="k">Length</span><span class="v">${esc(p.lengthM)} m</span></div>
        </div>
        ${sizeCtl}
        ${prodInfo}
        ${stackCtl}
        ${offsetNote}
        ${traceHtml}`;
      if (isStack) $('floorsInput').addEventListener('change', (e) => guarded('floors set', () => command({ type: 'StackFloorsSet', id: p.id, floors: Number(e.target.value) })));
      else $('slopeInput').addEventListener('change', (e) => guarded('slope changed', () => command({ type: 'PipeSlopeChanged', id: p.id, slopePct: Number(e.target.value) })));
    } else if (p.medium === 'vent') {
      box.innerHTML = `<h2>Vent pipe</h2>
        <div class="cards">
          <div class="stat big"><span class="k">Size</span><span class="v">${p.sizeOd != null ? 'Ø' + esc(p.sizeOd) + 'mm' : '—'}</span></div>
          <div class="stat"><span class="k">DFU protected</span><span class="v">${esc(p.cumulativeDfu)}</span></div>
          <div class="stat"><span class="k">Length</span><span class="v">${esc(p.lengthM)} m</span></div>
        </div>
        ${sizeCtl}
        ${prodInfo}
        ${traceHtml}`;
    } else if (p.medium === 'power') {
      const vb = p.velocityPass == null ? '' : `<span class="badge ${p.velocityPass ? 'ok' : 'bad'}">${p.velocityPass ? 'Vd within limit' : 'Vd / size fail'}</span>`;
      box.innerHTML = `<h2>Cable — power</h2>
        <div class="cards">
          <div class="stat big"><span class="k">Size</span><span class="v">${p.sizeOd != null ? esc(p.sizeOd) + ' mm²' : '—'}</span></div>
          <div class="stat"><span class="k">Current</span><span class="v">${escOr(p.cumulativeAmps)}</span><span class="k">A</span></div>
          <div class="stat"><span class="k">Volt drop</span><span class="v">${p.vdPct != null ? esc(p.vdPct) + '%' : '—'}</span> ${vb}</div>
          <div class="stat"><span class="k">Length</span><span class="v">${esc(p.lengthM)} m</span></div>
        </div>
        ${sizeCtl}
        ${prodInfo}
        ${traceHtml}`;
    } else if (p.medium === 'air') {
      const vb = p.velocityPass == null ? '' : `<span class="badge ${p.velocityPass ? 'ok' : 'bad'}">${p.velocityPass ? 'within limit' : 'over limit'}</span>`;
      box.innerHTML = `<h2>Duct — air</h2>
        <div class="cards">
          <div class="stat big"><span class="k">Size</span><span class="v">${p.sizeOd != null ? 'Ø' + esc(p.sizeOd) + 'mm' : '—'}</span></div>
          <div class="stat"><span class="k">Airflow</span><span class="v">${escOr(p.cumulativeAirLps)}</span><span class="k">L/s</span></div>
          <div class="stat"><span class="k">Velocity</span><span class="v">${escOr(p.velocityMs)}</span> ${vb}</div>
          <div class="stat"><span class="k">Length</span><span class="v">${esc(p.lengthM)} m</span></div>
        </div>
        ${sizeCtl}
        ${prodInfo}
        ${traceHtml}`;
    } else if (p.medium === 'beam') {
      box.innerHTML = `<h2>RC beam</h2>
        <div class="cards">
          <div class="stat big"><span class="k">Depth</span><span class="v">${p.sizeOd != null ? esc(p.sizeOd) + ' mm' : '—'}</span></div>
          <div class="stat"><span class="k">Span</span><span class="v">${esc(p.lengthM)} m</span></div>
          <div class="stat"><span class="k">Reinf</span><span class="v" style="font-size:16px">${escOr(p.reinf)}</span></div>
        </div>
        <label class="hint" style="display:block;margin-top:10px">Uniform load (kN/m)<br/><input id="beamInput" type="number" min="1" step="1" value="${esc(p.beamLoad ?? 15)}" style="width:100%;margin-top:4px;padding:6px;border-radius:7px;border:1px solid var(--line)"/></label>
        ${sizeCtl}
        ${traceHtml}`;
      $('beamInput').addEventListener('change', (e) => guarded('load set', () => command({ type: 'BeamLoadChanged', id: p.id, loadKnPerM: Number(e.target.value) })));
    } else {
      const vb = p.velocityPass == null ? '' : `<span class="badge ${p.velocityPass ? 'ok' : 'bad'}">${p.velocityPass ? 'within limit' : 'over limit'}</span>`;
      box.innerHTML = `<h2>Pipe — ${esc(p.medium)} supply</h2>
        <div class="cards">
          <div class="stat big"><span class="k">Size</span><span class="v">${p.sizeOd != null ? 'Ø' + esc(p.sizeOd) + 'mm' : '—'}</span></div>
          <div class="stat"><span class="k">Velocity</span><span class="v">${escOr(p.velocityMs)}</span> ${vb}</div>
          <div class="stat"><span class="k">Length</span><span class="v">${esc(p.lengthM)} m</span></div>
          <div class="stat"><span class="k">Demand</span><span class="v">${esc(p.demandLps)}</span><span class="k">L/s</span></div>
          <div class="stat"><span class="k">Head loss</span><span class="v">${esc(p.headlossM)} m</span></div>
        </div>
        ${sizeCtl}
        ${prodInfo}
        ${traceHtml}`;
    }
    const ss = $('sizeSel');
    if (ss) ss.addEventListener('change', (e) => guarded('size set', () => command({ type: 'PipeSizeSet', id: p.id, odMm: e.target.value ? Number(e.target.value) : null })));
    const cp = $('clearProd');
    if (cp) cp.addEventListener('click', () => guarded('cleared product', () => command({ type: 'PipeProductSet', id: p.id, product: null })));
    // routing controls (bends / right-angle) — available for every pipe medium
    const nWp = (p.waypoints || []).length;
    box.insertAdjacentHTML('beforeend', `<div class="route-ctl"><span class="hint" style="margin:0">Routing — <b>${esc(nWp)}</b> bend(s), length <b>${esc(p.lengthM)} m</b></span>
      <div class="route-btns"><button id="routeL" class="lib-place">⌐ Right-angle</button><button id="routeStraight" class="lib-place">─ Straight</button></div>
      <p class="hint" style="margin:6px 0 0">Double-click the pipe to add an elbow; drag the orange dots to route it around obstacles.</p>
      <button id="pipeDel" class="ghost" style="margin-top:10px;width:100%">🗑 Delete this pipe</button></div>`);
    $('routeL').addEventListener('click', () => { const a = nodeById(p.from), b = nodeById(p.to); if (!a || !b) return; guarded('right-angle route', () => command({ type: 'PipeReroute', id: p.id, waypoints: [{ x: snap(b.x), y: snap(a.y) }] })); });
    $('routeStraight').addEventListener('click', () => guarded('straightened', () => command({ type: 'PipeReroute', id: p.id, waypoints: [] })));
    $('pipeDel').addEventListener('click', () => { const id = p.id; selId = null; selKind = null; guarded('deleted', () => command({ type: 'PipeRemoved', id })); });
  } else if (selKind === 'node') {
    const n = nodeById(selId);
    if (!n) return void (box.innerHTML = '<h2>Inspector</h2><p class="hint">Select a pipe or fixture.</p>');
    const NODE_TITLE = { source: 'Source (tank)', outlet: 'Sewer / outlet', 'vent-terminal': 'Vent terminal (roof)', panel: 'Electrical panel (DB)', ahu: 'Air handling unit (AHU)', support: 'Support / column', junction: 'Junction', fitting: 'Pipe fitting' };
    const elevCtl = `<label class="hint" style="display:block;margin-top:10px">Elevation (height, m)<br/><input id="elevInput" type="number" step="0.1" value="${esc(n.z ?? 0)}" style="width:100%;margin-top:4px;padding:6px;border-radius:7px;border:1px solid var(--line)"/></label>`;
    const posHtml = `<p class="hint">Position: ${n.x.toFixed(2)}, ${n.y.toFixed(2)} m · elevation ${esc(n.z ?? 0)} m</p>`;
    if (n.kind === 'fixture') {
      box.innerHTML = `<h2>Fixture</h2><label class="hint">Type<br/><select id="typeSel" style="width:100%;margin-top:4px;padding:6px;border-radius:7px;border:1px solid var(--line)">
        ${current.fixtureTypes.map((t) => `<option value="${esc(t)}" ${t === n.fixtureType ? 'selected' : ''}>${esc(FIXTURE_LABEL[t] ?? t)}</option>`).join('')}
        </select></label>${elevCtl}${posHtml}`;
      $('typeSel').addEventListener('change', (e) => guarded('type changed', () => command({ type: 'FixtureTypeChanged', id: n.id, fixtureType: e.target.value })));
    } else if (n.kind === 'load') {
      box.innerHTML = `<h2>Electrical load</h2><label class="hint">Design current (A)<br/><input id="loadInput" type="number" min="1" step="1" value="${esc(n.loadA ?? 10)}" style="width:100%;margin-top:4px;padding:6px;border-radius:7px;border:1px solid var(--line)"/></label>${elevCtl}${posHtml}`;
      $('loadInput').addEventListener('change', (e) => guarded('load set', () => command({ type: 'NodeLoadChanged', id: n.id, amps: Number(e.target.value) })));
    } else if (n.kind === 'diffuser') {
      box.innerHTML = `<h2>Air diffuser</h2><label class="hint">Airflow (L/s)<br/><input id="airInput" type="number" min="5" step="5" value="${esc(n.airflowLps ?? 50)}" style="width:100%;margin-top:4px;padding:6px;border-radius:7px;border:1px solid var(--line)"/></label>${elevCtl}${posHtml}`;
      $('airInput').addEventListener('change', (e) => guarded('airflow set', () => command({ type: 'NodeAirflowChanged', id: n.id, airLps: Number(e.target.value) })));
    } else if (n.kind === 'support') {
      const col = n.column;
      const pass = !!(col && col.pass);
      const badge = col ? `<span class="badge ${pass ? 'ok' : 'bad'}">${pass ? 'OK' : 'over capacity'}</span>` : '';
      const traceHtml = col ? `<h3>Sizing trace</h3><ol class="trace">${col.steps.map((st) => { const ok = /ok/.test(st.result); return `<li>${esc(st.expr)} <span class="${ok ? 'pass' : 'fail'}">→ ${esc(st.result)}</span></li>`; }).join('')}</ol><p class="clause">Clause: ${esc(col.clause)}</p>` : '';
      const manual = n.axialOverride != null;
      const floors = n.floorsSupported || 1;
      const perFloor = n.axialPerFloor ?? 0;
      const loadBadge = manual ? '<span class="badge ok">manual</span>' : '<span class="badge">auto from beams</span>';
      const inStyle = 'width:100%;margin-top:4px;padding:6px;border-radius:7px;border:1px solid var(--line)';
      box.innerHTML = `<h2>RC column</h2>
        <div class="cards">
          <div class="stat big"><span class="k">Section</span><span class="v">${col && col.size != null ? esc(col.size) + '×' + esc(col.size) : '—'}</span></div>
          <div class="stat"><span class="k">Total Pu</span><span class="v" style="font-size:16px">${esc(n.axialLoadKn ?? 0)}</span><span class="k">kN</span> ${badge}</div>
          <div class="stat"><span class="k">Utilisation</span><span class="v">${col ? escOr(col.utilization) : '—'}</span></div>
          <div class="stat"><span class="k">Reinf</span><span class="v" style="font-size:14px">${col ? escOr(col.reinforcement) : '—'}</span></div>
        </div>
        <label class="hint" style="display:block;margin-top:10px">Axial load per floor (kN) ${loadBadge}<br/><input id="axialInput" type="number" min="0" step="50" value="${esc(perFloor)}" style="${inStyle}"/></label>
        <label class="hint" style="display:block;margin-top:8px">Floors supported (multi-storey)<br/><input id="floorsInput" type="number" min="1" step="1" value="${esc(floors)}" style="${inStyle}"/></label>
        <p class="hint" style="margin-top:6px"><b>${esc(perFloor)}</b> kN/floor × <b>${esc(floors)}</b> floor(s) = <b>${esc(n.axialLoadKn ?? 0)} kN</b>. Framing beams give ${esc(n.axialFromBeams ?? 0)} kN/floor (Σ w·L/2).${manual ? ` <button id="autoAxial" class="lib-place" style="margin-top:6px">Use auto (from beams)</button>` : ''}</p>
        ${elevCtl}${posHtml}${traceHtml}`;
      $('axialInput').addEventListener('change', (e) => guarded('axial load set', () => command({ type: 'AxialLoadChanged', id: n.id, axialLoadKn: Number(e.target.value) })));
      $('floorsInput').addEventListener('change', (e) => guarded('floors set', () => command({ type: 'FloorsSupportedChanged', id: n.id, floors: Number(e.target.value) })));
      const aa = $('autoAxial');
      if (aa) aa.addEventListener('click', () => guarded('axial → auto', () => command({ type: 'AxialLoadChanged', id: n.id, axialLoadKn: null })));
    } else if (n.kind === 'fitting') {
      const FIT_LABEL = { elbow90: 'Elbow 90°', elbow45: 'Elbow 45°', tee: 'Tee', cross: 'Cross', coupling: 'Coupling', reducer: 'Reducer', union: 'Union', endcap: 'End cap', transition: 'Transition (brass)', valve: 'Valve' };
      const { type: ftype, od: fod } = parseFit(n.fixtureType);
      const SIZES = [20, 25, 32, 40, 50, 63, 75, 90, 110];
      const enc = (t, o) => t + (o ? '|' + o : '');
      const selStyle = 'width:100%;margin-top:4px;padding:6px;border-radius:7px;border:1px solid var(--line)';
      box.innerHTML = `<h2>Pipe fitting</h2>
        <label class="hint">Type<br/><select id="fitSel" style="${selStyle}">${Object.keys(FIT_LABEL).map((t) => `<option value="${esc(t)}" ${t === ftype ? 'selected' : ''}>${esc(FIT_LABEL[t])}</option>`).join('')}</select></label>
        <label class="hint" style="display:block;margin-top:8px">Size<br/><select id="fitSize" style="${selStyle}"><option value="">— unsized</option>${SIZES.map((o) => `<option value="${esc(o)}" ${o === fod ? 'selected' : ''}>Ø${esc(o)}mm</option>`).join('')}</select></label>
        <p class="hint" style="margin-top:6px">Connect pipes with the <b>Pipe</b> tool; rotate to align it with the run.</p>${elevCtl}${posHtml}`;
      $('fitSel').addEventListener('change', (e) => guarded('fitting type', () => command({ type: 'FixtureTypeChanged', id: n.id, fixtureType: enc(e.target.value, fod) })));
      $('fitSize').addEventListener('change', (e) => guarded('fitting size', () => command({ type: 'FixtureTypeChanged', id: n.id, fixtureType: enc(ftype, e.target.value ? Number(e.target.value) : null) })));
    } else {
      box.innerHTML = `<h2>${esc(NODE_TITLE[n.kind] ?? 'Node')}</h2>${elevCtl}${posHtml}`;
    }
    const ei = $('elevInput');
    if (ei) ei.addEventListener('change', (e) => guarded('elevation set', () => command({ type: 'NodeElevationChanged', id: n.id, z: Number(e.target.value) })));
    // rotation + delete — available for every component, in 2D and 3D
    box.insertAdjacentHTML('beforeend', `<div class="route-ctl"><span class="hint" style="margin:0">Rotation <b>${esc(Math.round(n.rotationDeg || 0))}°</b></span>
      <div class="route-btns"><button id="rotL" class="lib-place">⟲ −90°</button><button id="rotR" class="lib-place">⟳ +90°</button></div>
      <input id="rotInput" type="range" min="0" max="359" step="5" value="${esc(Math.round(n.rotationDeg || 0))}" style="width:100%;margin-top:6px" title="Drag to rotate"/>
      <button id="nodeDel" class="ghost" style="margin-top:10px;width:100%">🗑 Delete this item</button></div>`);
    const rotBy = (d) => guarded('rotated', () => command({ type: 'NodeRotated', id: n.id, deg: (n.rotationDeg || 0) + d }));
    $('rotL').addEventListener('click', () => rotBy(-90));
    $('rotR').addEventListener('click', () => rotBy(90));
    $('rotInput').addEventListener('change', (e) => guarded('rotated', () => command({ type: 'NodeRotated', id: n.id, deg: Number(e.target.value) })));
    $('nodeDel').addEventListener('click', () => { const id = n.id; selId = null; selKind = null; guarded('deleted', () => command({ type: 'NodeRemoved', id })); });
  } else if (selKind === 'slab') {
    const sl = (current.slabs || []).find((x) => x.id === selId);
    if (!sl) return void (box.innerHTML = '<h2>Inspector</h2><p class="hint">Select a pipe, fixture or slab.</p>');
    const pass = sl.pass !== false;
    const badge = `<span class="badge ${pass ? 'ok' : 'bad'}">${pass ? esc(sl.type || 'ok') : 'span too large'}</span>`;
    const traceHtml = `<h3>Sizing trace</h3><ol class="trace">${sl.steps.map((st) => { const ok = /≥|ok/.test(st.result); return `<li>${esc(st.expr)} <span class="${ok ? 'pass' : 'fail'}">→ ${esc(st.result)}</span></li>`; }).join('')}</ol><p class="clause">Clause: ${esc(sl.clause)}</p>`;
    box.innerHTML = `<h2>RC slab</h2>
      <div class="cards">
        <div class="stat big"><span class="k">Thickness</span><span class="v">${sl.thickness != null ? esc(sl.thickness) + ' mm' : '—'}</span> ${badge}</div>
        <div class="stat"><span class="k">Area</span><span class="v">${esc(sl.areaM2)}</span><span class="k">m²</span></div>
        <div class="stat"><span class="k">Spans</span><span class="v" style="font-size:14px">${escOr(sl.shortSpan)} / ${escOr(sl.longSpan)}</span></div>
        <div class="stat"><span class="k">Steel</span><span class="v" style="font-size:13px">${escOr(sl.steel)}</span></div>
      </div>
      <label class="hint" style="display:block;margin-top:10px">Applied load (kN/m²)<br/><input id="slabLoad" type="number" min="0" step="0.5" value="${esc(sl.loadKnPerM2)}" style="width:100%;margin-top:4px;padding:6px;border-radius:7px;border:1px solid var(--line)"/></label>
      <button id="slabDel" class="ghost" style="margin-top:10px">Delete slab</button>
      ${traceHtml}`;
    $('slabLoad').addEventListener('change', (e) => guarded('slab load set', () => command({ type: 'SlabLoadChanged', id: sl.id, loadKnPerM2: Number(e.target.value) })));
    $('slabDel').addEventListener('click', () => { selId = null; selKind = null; guarded('deleted slab', () => command({ type: 'SlabRemoved', id: sl.id })); });
  } else box.innerHTML = '<h2>Inspector</h2><p class="hint">Select a pipe, fixture or slab to see its engineering. Use the <b>Pipe</b> tool to connect items, or <b>Slab</b> to enclose a floor panel.</p>';
}
function renderBoq() {
  const byGroup = {};
  for (const l of current.boq) (byGroup[l.group || 'Other'] ??= []).push(l);
  let html = '';
  for (const g of Object.keys(byGroup).sort()) {
    const lines = byGroup[g];
    const sub = Math.round(lines.reduce((s, l) => s + (l.lineCost || 0), 0) * 100) / 100;
    html += `<tr class="boq-group"><td colspan="4">${esc(g)}</td></tr>`;
    html += lines.map((l) => `<tr><td>${esc(l.description)}</td><td>${esc(l.qty)}</td><td>${esc(l.unit)}</td><td>${l.lineCost != null ? esc(l.lineCost) : ''}</td></tr>`).join('');
    html += `<tr class="boq-sub"><td colspan="3">subtotal</td><td>${esc(sub)}</td></tr>`;
  }
  if (current.costTotal != null) html += `<tr class="boq-total"><td colspan="3">Project total</td><td>${esc(current.costTotal)}</td></tr>`;
  $('boq').innerHTML = html || '<tr><td colspan="4" style="color:var(--muted)">empty</td></tr>';
  const fails = current.pipes.filter((p) => p.sizePass === false || p.velocityPass === false).length;
  $('validation').innerHTML = fails === 0 ? '<span class="v-ok">✓ all pipes pass validation</span>' : `<span class="v-bad">✕ ${esc(fails)} pipe(s) fail — see red lines</span>`;
}
function togglePressureMode() {
  pressureMode = !pressureMode;
  $('pressure').classList.toggle('active', pressureMode);
  status(pressureMode ? 'pressure map on — critical path highlighted, residuals tagged' : 'pressure map off');
  render();
}
function renderHydraulics() {
  const el = $('hydraulics');
  const pr = current.pressure;
  if (!pr || !pr.hasSource) {
    el.innerHTML = `<p class="hint" style="margin:0">Place a <b>Tank / Source</b>, connect fixtures with cold/hot pipe, then set the tank as the source. The solver reports residual pressure at every outlet and finds the critical path.</p>`;
    return;
  }
  const worst = pr.worst;
  const worstCls = worst ? (worst.pass ? 'ok' : 'bad') : '';
  const okBadge = pr.allPass
    ? '<span class="badge ok">every outlet OK</span>'
    : `<span class="badge bad">${pr.failing ? esc(pr.failing) + ' under-pressure' : ''}${pr.failing && pr.overpressure ? ' · ' : ''}${pr.overpressure ? esc(pr.overpressure) + ' over-pressure (needs PRV)' : ''}</span>`;
  const inStyle = 'width:100%;margin-top:4px;padding:6px;border-radius:7px;border:1px solid var(--line)';
  const rows = pr.fixtures.slice().sort((a, b) => a.residualKPa - b.residualKPa).map((f) =>
    `<div class="prow ${f.pass ? '' : 'bad'} ${f.over ? 'over' : ''}"><span>${esc(FIXTURE_LABEL[f.type] || f.type)}</span><b>${esc(f.residualKPa)} kPa</b></div>`).join('');
  el.innerHTML = `
    <div class="cards">
      <div class="stat big"><span class="k">Critical outlet</span><span class="v" style="font-size:15px">${worst ? esc(FIXTURE_LABEL[worst.type] || worst.type) : '—'}</span> ${worst ? `<span class="badge ${worstCls}">${worst.pass ? 'OK' : 'low'}</span>` : ''}</div>
      <div class="stat"><span class="k">Residual</span><span class="v">${worst ? esc(worst.residualKPa) : '—'}</span><span class="k">kPa</span></div>
      <div class="stat"><span class="k">Code min</span><span class="v">${esc(pr.minResidualKPa)}</span><span class="k">kPa</span></div>
      <div class="stat"><span class="k">Head loss</span><span class="v">${esc(pr.totalFrictionM)}</span><span class="k">m total</span></div>
      <div class="stat"><span class="k">Fittings</span><span class="v">${esc(pr.minorToCriticalM ?? 0)}</span><span class="k">m · ${esc(pr.criticalFittings ?? 0)} on path</span></div>
    </div>
    <label class="hint" style="display:block;margin-top:10px">Supply pressure at source (kPa) — municipal + booster / tank head<br/><input id="supplyP" type="number" min="0" step="10" value="${esc(pr.supplyPressureKPa)}" style="${inStyle}"/></label>
    <div class="hyd-status">${okBadge}<button id="pmapToggle" class="lib-place">${pressureMode ? '✓ Pressure map on' : '🌡 Show pressure map'}</button></div>
    ${remedyHtml(pr.remedy)}
    <div class="plist">${rows}</div>
    <p class="hint" style="margin-top:8px">Residual = supply pressure + static (elevation) head − Hazen–Williams pipe friction − fitting minor losses (K·v²/2g). Velocity head excluded.</p>
    ${recircHtml(current.recirc)}`;
  $('supplyP').addEventListener('change', (e) => guarded('supply pressure set', () => command({ type: 'SupplyPressureSet', kPa: Number(e.target.value) })));
  const rf = $('recircFlow');
  if (rf) rf.addEventListener('change', (e) => guarded('recirc flow set', () => command({ type: 'RecircFlowSet', lps: Number(e.target.value) })));
  $('pmapToggle').addEventListener('click', togglePressureMode);
  const rr = pr.remedy;
  if (rr) {
    const raiseBtn = $('fixRaise');
    if (raiseBtn) raiseBtn.addEventListener('click', () => guarded('raised supply', () => command({ type: 'SupplyPressureSet', kPa: rr.raiseSupplyToKPa })));
    const upBtn = $('fixUpsize');
    if (upBtn) upBtn.addEventListener('click', () => guarded('upsized critical path', () => command(rr.upsize.map((u) => ({ type: 'PipeSizeSet', id: u.pipeId, odMm: u.toOd })))));
  }
}
// Hot-water recirculation loop panel (shown only when a hot return closes a loop).
function recircHtml(rc) {
  if (!rc || !rc.active) return '';
  const inStyle = 'width:100%;margin-top:4px;padding:6px;border-radius:7px;border:1px solid var(--line)';
  const vb = rc.returnVelocityMps != null ? `<span class="hint" style="margin:0"> · return ${esc(rc.returnVelocityMps)} m/s</span>` : '';
  return `<div class="recirc-panel">
    <div class="recirc-title">♨ Hot-water recirculation</div>
    <div class="cards" style="margin:6px 0 0">
      <div class="stat big"><span class="k">Recirc pump head</span><span class="v">${esc(rc.pumpHeadKPa)}</span><span class="k">kPa</span></div>
      <div class="stat"><span class="k">Loop length</span><span class="v">${esc(rc.loopLengthM)}</span><span class="k">m</span></div>
      <div class="stat"><span class="k">Loop friction</span><span class="v">${esc(rc.frictionM)}</span><span class="k">m</span></div>
    </div>
    <label class="hint" style="display:block;margin-top:8px">Recirculation flow (L/s) — heat-loss make-up${vb}<br/><input id="recircFlow" type="number" min="0" step="0.02" value="${esc(rc.recircFlowLps)}" style="${inStyle}"/></label>
    ${recircBranchesHtml(rc.branches)}
    <p class="hint" style="margin-top:6px">Pump head = Hazen–Williams friction around the governing loop. Turn on the pressure map to highlight the loop.</p>
  </div>`;
}
// Balancing-valve schedule (only when there is more than one recirculation branch).
function recircBranchesHtml(branches) {
  if (!branches || branches.length < 2) return '';
  const rows = branches.slice().sort((a, b) => b.frictionM - a.frictionM).map((b) =>
    `<div class="prow ${b.isIndex ? '' : 'over'}"><span>return ${esc(b.returnPipeId)} · ${esc(b.flowLps)} L/s</span><b>${b.isIndex ? 'index — valve open' : 'Kv ' + escOr(b.balanceValveKv)}</b></div>`).join('');
  return `<div style="margin-top:8px"><div class="fix-title" style="color:var(--hot)">Balancing valves</div><div class="plist" style="margin-top:6px">${rows}</div></div>`;
}
// One-click remedy panel when the pressure balance fails.
function remedyHtml(rr) {
  if (!rr) return '';
  const parts = [];
  if (rr.under && rr.raiseSupplyToKPa != null) {
    parts.push(`<button id="fixRaise" class="fix-btn">⚑ Raise supply to ${esc(rr.raiseSupplyToKPa)} kPa</button>`);
    if (rr.raiseCausesOverpressure) parts.push(`<p class="fix-note warn">Raising supply would over-pressure another outlet — prefer upsizing.</p>`);
  }
  if (rr.under && rr.upsizeAchievesPass && rr.upsize.length) {
    const detail = rr.upsize.map((u) => `Ø${esc(u.fromOd)}→${esc(u.toOd)}`).join(', ');
    parts.push(`<button id="fixUpsize" class="fix-btn alt">⤢ Upsize ${esc(rr.upsize.length)} pipe(s) on the critical path</button><p class="fix-note">Keeps supply as-is · ${detail}</p>`);
  }
  if (rr.under && !rr.upsizeAchievesPass) parts.push(`<p class="fix-note">Upsizing alone can't reach the minimum — raise the supply pressure.</p>`);
  if (rr.prvNeeded) parts.push(`<p class="fix-note warn">Over-pressure by ${esc(rr.overByKPa)} kPa — a pressure-reducing valve (PRV) is required at the zone.</p>`);
  return parts.length ? `<div class="fix-panel"><div class="fix-title">⚑ Auto-fix</div>${parts.join('')}</div>` : '';
}
function renderLog() {
  $('log').innerHTML = current.log.map((e, i) => {
    const detail = e.fixtureType ?? e.id ?? '';
    return `<li>${String(i + 1).padStart(2, '0')} <b>${esc(e.type)}</b> ${esc(detail)}</li>`;
  }).join('');
}

/* ---------- palette ---------- */
let paletteSignature = '';
function populatePalette(types) {
  const box = $('fixturePalette');
  if (!types || !types.length) return;
  // Rebuild only when the fixture list actually changes — switching jurisdiction can add or remove
  // fixture types, and the palette has to follow.
  const signature = types.join('|');
  if (signature === paletteSignature) return;
  paletteSignature = signature;
  box.innerHTML = '';
  for (const t of types) {
    const chip = document.createElement('div');
    chip.className = 'chip';
    chip.draggable = true;
    chip.dataset.kind = 'fixture';
    chip.dataset.type = t;
    chip.textContent = '＋ ' + (FIXTURE_LABEL[t] ?? t);
    box.appendChild(chip);
  }
}
// Delegated so chips rebuilt on a jurisdiction change stay draggable without re-binding listeners.
document.querySelector('.palette').addEventListener('dragstart', (e) => {
  const chip = e.target.closest('.chip[data-kind]');
  if (!chip) return;
  e.dataTransfer.setData('application/x-bg', JSON.stringify({ kind: chip.dataset.kind, type: chip.dataset.type }));
});
// Click-to-place: clicking a palette chip arms placement (then click the canvas), as an alternative to drag.
document.querySelector('.palette').addEventListener('click', (e) => {
  const chip = e.target.closest('.chip[data-kind]');
  if (!chip) return;
  const kind = chip.dataset.kind, type = chip.dataset.type;
  placing = kind === 'fixture' ? { kind: 'fixture', fixtureType: type } : { kind };
  status('click the canvas (2D or 3D) to place ' + (type || kind) + ' — Esc to cancel');
});
function placeFromPalette(spec, cx, cy) {
  let x, y;
  if (viewMode === '3d' && three && three.floorPointAt) {
    const pt = three.floorPointAt(cx, cy);
    if (!pt) return void status('drop onto the floor');
    x = clampX(snap(pt.x)); y = clampY(snap(pt.z));
  } else {
    const m = toModel(cx, cy); x = clampX(snap(m.x)); y = clampY(snap(m.y));
  }
  const id = uid('n_');
  const ev = spec.kind === 'fixture' ? { type: 'NodeAdded', id, kind: 'fixture', x, y, fixtureType: spec.type } : { type: 'NodeAdded', id, kind: spec.kind, x, y };
  guarded('placed ' + (spec.type || spec.kind), () => command(ev));
}

/* ---------- pointer interaction (2D only) ---------- */
// Where on a pipe the pointer landed: which routed segment, and the point along it. Routing bends
// mean a pipe is a polyline, not a line, so the search runs over every segment of the route.
function closestPointOnPipe(p, cx, cy) {
  const pts = pipePoints(p, false);
  const m = toModel(cx, cy);
  if (!pts || pts.length < 2) return null;

  let best = { segment: 0, distance: Infinity, x: m.x, y: m.y };
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    const dx = b.x - a.x, dy = b.y - a.y;
    const along = Math.max(0, Math.min(1, ((m.x - a.x) * dx + (m.y - a.y) * dy) / (dx * dx + dy * dy || 1e-9)));
    const x = a.x + along * dx, y = a.y + along * dy;
    const distance = Math.hypot(m.x - x, m.y - y);
    if (distance < best.distance) best = { segment: i, distance, x, y };
  }
  return { segment: best.segment, x: clampX(snap(best.x)), y: clampY(snap(best.y)) };
}

// Split a pipe at the click point, inserting a junction — this is how a branch tees into a run.
// The original route is preserved: bends before the split stay on the first half, bends after it on
// the second, so tapping a routed pipe does not straighten it.
async function tapPipe(p, cx, cy) {
  const at = closestPointOnPipe(p, cx, cy);
  if (!at) return null;

  const bends = (p.waypoints || []).map((w) => ({ x: w.x, y: w.y }));
  const before = bends.slice(0, at.segment);
  const after = bends.slice(at.segment);

  const junctionId = uid('n_');
  const firstId = uid('p_'), secondId = uid('p_');
  const pipe = (id, from, to) => ({ type: 'PipeAdded', id, from, to, medium: p.medium, slopePct: p.slopePct ?? undefined });

  const events = [
    { type: 'NodeAdded', id: junctionId, kind: 'junction', x: at.x, y: at.y },
    { type: 'PipeRemoved', id: p.id },
    pipe(firstId, p.from, junctionId),
    pipe(secondId, junctionId, p.to),
  ];
  if (before.length) events.push({ type: 'PipeReroute', id: firstId, waypoints: before });
  if (after.length) events.push({ type: 'PipeReroute', id: secondId, waypoints: after });

  await command(events);
  return junctionId;
}
// draw a pipe and, if a catalog pipe product is active, apply it (its OD + material)
async function drawPipe(from, to) {
  const pid = uid('p_');
  await command({ type: 'PipeAdded', id: pid, from, to, medium: pipeMedium });
  if (activePipeProduct) await command({ type: 'PipeProductSet', id: pid, product: activePipeProduct });
}
// live drag: move node group(s) and re-point their pipe polylines without a server round-trip
function applyLive(posMap) {
  for (const id in posMap) { const g = svg.querySelector(`[data-node="${id}"]`); if (g) g.setAttribute('transform', `translate(${posMap[id].x} ${posMap[id].y})`); }
  for (const p of current.pipes) {
    if (!(p.from in posMap) && !(p.to in posMap)) continue;
    repointPipe(p, pipePoints(p, true, posMap), pipePoints(p, false, posMap));
  }
}
// Update a pipe's rendered polylines in place (schematic outline/fill + centre + hit).
function repointPipe(p, pts, raw) {
  if (!pts) return;
  const s = ptStr(pts);
  svg.querySelectorAll(`g[data-pipe="${p.id}"] polyline`).forEach((el) => {
    if (el.classList.contains('pcad-edge')) return; // CAD offset lines snap on release
    el.setAttribute('points', el.classList.contains('pipe-hit') ? ptStr(raw || pts) : s);
  });
}

svg.addEventListener('pointerdown', (e) => {
  if (viewMode === '3d') return;
  if (placing) {
    const m = toModel(e.clientX, e.clientY), x = clampX(snap(m.x)), y = clampY(snap(m.y));
    const ev = placing.fixtureType ? { type: 'NodeAdded', id: uid('n_'), kind: placing.kind, x, y, fixtureType: placing.fixtureType } : { type: 'NodeAdded', id: uid('n_'), kind: placing.kind, x, y };
    const label = placing.label || placing.fixtureType || placing.kind; placing = null;
    return void guarded('placed ' + label, () => command(ev));
  }
  const nodeG = e.target.closest('[data-node]'), pipeEl = e.target.closest('[data-pipe]'), slabG = e.target.closest('[data-slab]');
  const wpEl = e.target.closest('[data-waypoint]');
  const pipeOf = (el) => current.pipes.find((x) => x.id === el.getAttribute('data-pipe'));
  if (tool === 'select' && wpEl) { // drag an existing bend
    const [pid, idx] = wpEl.getAttribute('data-waypoint').split(':');
    drag = { type: 'waypoint', pipeId: pid, index: Number(idx), moved: false };
    svg.setPointerCapture(e.pointerId);
    return;
  }
  if (tool === 'slab') {
    if (nodeG) {
      const id = nodeG.getAttribute('data-node');
      if (slabCorners.length >= 3 && slabCorners[0] === id) return void commitSlab(); // click first corner to close
      if (!slabCorners.includes(id)) { slabCorners.push(id); render(); status(`slab: ${slabCorners.length} corner(s) — click the first corner or press Enter to close, Esc to cancel`); }
    }
    return;
  }
  if (tool === 'select') {
    if (nodeG) {
      const id = nodeG.getAttribute('data-node'), n = nodeById(id), m = toModel(e.clientX, e.clientY);
      drag = { type: 'node', id, offx: n.x - m.x, offy: n.y - m.y, moved: false }; svg.setPointerCapture(e.pointerId);
    } else if (pipeEl) {
      const p = pipeOf(pipeEl), m = toModel(e.clientX, e.clientY);
      drag = { type: 'pipe', pipeId: p.id, from: p.from, to: p.to, startX: m.x, startY: m.y, moved: false }; svg.setPointerCapture(e.pointerId);
    } else if (slabG) {
      selId = slabG.getAttribute('data-slab'); selKind = 'slab'; render();
    } else { selId = null; selKind = null; render(); }
  } else if (tool === 'pipe') {
    if (nodeG) {
      const id = nodeG.getAttribute('data-node');
      if (!pendingFrom) { pendingFrom = id; render(); }
      else if (pendingFrom !== id) { const from = pendingFrom; pendingFrom = null; guarded('pipe routed', () => drawPipe(from, id)); }
      else { pendingFrom = null; render(); }
    } else if (pipeEl) {
      const p = pipeOf(pipeEl);
      guarded('branched off pipe', async () => {
        const jid = await tapPipe(p, e.clientX, e.clientY);
        if (pendingFrom && pendingFrom !== jid) { const from = pendingFrom; pendingFrom = null; await drawPipe(from, jid); }
        else { pendingFrom = jid; render(); }
      });
    }
  } else if (tool === 'delete') {
    if (nodeG) guarded('deleted node', () => command({ type: 'NodeRemoved', id: nodeG.getAttribute('data-node') }));
    else if (pipeEl) guarded('deleted pipe', () => command({ type: 'PipeRemoved', id: pipeEl.getAttribute('data-pipe') }));
    else if (slabG) guarded('deleted slab', () => command({ type: 'SlabRemoved', id: slabG.getAttribute('data-slab') }));
  }
});

function commitSlab() {
  if (slabCorners.length < 3) { status('a slab needs at least 3 corners'); return; }
  const corners = slabCorners.slice(); slabCorners = [];
  guarded('slab created', () => command({ type: 'SlabAdded', id: uid('sl_'), corners }));
}

svg.addEventListener('pointermove', (e) => {
  if (!drag) return;
  const m = toModel(e.clientX, e.clientY);
  if (drag.type === 'node') {
    const x = clampX(m.x + drag.offx), y = clampY(m.y + drag.offy);
    if (Math.abs(x - nodeById(drag.id).x) > 0.03 || Math.abs(y - nodeById(drag.id).y) > 0.03) drag.moved = true;
    drag.live = { [drag.id]: { x, y } };
    applyLive(drag.live);
  } else if (drag.type === 'pipe') {
    const dx = m.x - drag.startX, dy = m.y - drag.startY;
    if (Math.hypot(dx, dy) > 0.04) drag.moved = true;
    const a = nodeById(drag.from), b = nodeById(drag.to);
    drag.live = { [drag.from]: { x: clampX(a.x + dx), y: clampY(a.y + dy) }, [drag.to]: { x: clampX(b.x + dx), y: clampY(b.y + dy) } };
    applyLive(drag.live);
  } else if (drag.type === 'waypoint') {
    const p = current.pipes.find((x) => x.id === drag.pipeId); if (!p) return;
    let x = clampX(m.x), y = clampY(m.y);
    // right-angle snap: align with the neighbours on the route (from, waypoints, to)
    const route = [nodeById(p.from), ...(p.waypoints || []), nodeById(p.to)];
    const prev = route[drag.index], next = route[drag.index + 2]; // neighbours of this waypoint
    if (prev && Math.abs(x - prev.x) < 0.35) x = prev.x; else if (next && Math.abs(x - next.x) < 0.35) x = next.x;
    if (prev && Math.abs(y - prev.y) < 0.35) y = prev.y; else if (next && Math.abs(y - next.y) < 0.35) y = next.y;
    drag.moved = true; drag.pos = { x, y };
    const wps = (p.waypoints || []).map((w) => ({ x: w.x, y: w.y })); wps[drag.index] = { x, y };
    const tmp = { ...p, waypoints: wps };
    repointPipe(p, pipePoints(tmp, true), pipePoints(tmp, false));
    const h = svg.querySelector(`[data-waypoint="${p.id}:${drag.index}"]`); if (h) { h.setAttribute('cx', x.toFixed(3)); h.setAttribute('cy', y.toFixed(3)); }
  }
});

svg.addEventListener('pointerup', (e) => {
  if (!drag) return; const d = drag; drag = null; try { svg.releasePointerCapture(e.pointerId); } catch {}
  if (d.type === 'node') {
    if (!d.moved) { selId = d.id; selKind = 'node'; render(); return; }
    const p = d.live[d.id]; selId = d.id; selKind = 'node';
    guarded('moved', () => command({ type: 'NodeMoved', id: d.id, x: snap(p.x), y: snap(p.y) }));
  } else if (d.type === 'pipe') {
    if (!d.moved) { selId = d.pipeId; selKind = 'pipe'; render(); return; }
    const fp = d.live[d.from], tp = d.live[d.to]; selId = d.pipeId; selKind = 'pipe';
    guarded('moved pipe', () => command([{ type: 'NodeMoved', id: d.from, x: snap(fp.x), y: snap(fp.y) }, { type: 'NodeMoved', id: d.to, x: snap(tp.x), y: snap(tp.y) }]));
  } else if (d.type === 'waypoint') {
    selId = d.pipeId; selKind = 'pipe';
    if (!d.moved || !d.pos) { render(); return; }
    const p = current.pipes.find((x) => x.id === d.pipeId);
    const wps = (p ? p.waypoints || [] : []).map((w) => ({ x: w.x, y: w.y }));
    wps[d.index] = { x: snap(d.pos.x), y: snap(d.pos.y) };
    guarded('rerouted pipe', () => command({ type: 'PipeReroute', id: d.pipeId, waypoints: wps }));
  }
  applyRemote();
});

// double-click a pipe to add a bend (elbow) at that point
svg.addEventListener('dblclick', (e) => {
  if (viewMode === '3d') return;
  const pipeEl = e.target.closest('[data-pipe]'); if (!pipeEl) return;
  const p = current.pipes.find((x) => x.id === pipeEl.getAttribute('data-pipe')); if (!p) return;
  const m = toModel(e.clientX, e.clientY);
  const pts = pipePoints(p, false);
  let bi = 0, bd = Infinity;
  for (let i = 0; i < pts.length - 1; i++) { const d = distToSeg(m, pts[i], pts[i + 1]); if (d < bd) { bd = d; bi = i; } }
  const wps = (p.waypoints || []).map((w) => ({ x: w.x, y: w.y }));
  wps.splice(bi, 0, { x: snap(clampX(m.x)), y: snap(clampY(m.y)) });
  selId = p.id; selKind = 'pipe';
  guarded('added bend', () => command({ type: 'PipeReroute', id: p.id, waypoints: wps }));
});

/* ---------- tools & views ---------- */
function setTool(t) { tool = t; pendingFrom = null; slabCorners = []; document.querySelectorAll('.tool').forEach((b) => b.classList.toggle('active', b.dataset.tool === t)); render(); }
document.querySelectorAll('.tool').forEach((b) => b.addEventListener('click', () => setTool(b.dataset.tool)));

/* ---------- 3D editing callbacks (click-select + drag-move in the 3D view) ---------- */
function on3DSelect(kind, id) {
  if (!kind) { selId = null; selKind = null; } else { selId = id; selKind = kind === 'pipe' ? 'pipe' : 'node'; }
  renderInspector();
  if (three && three.select) three.select(selId, selKind);
}
function on3DNodeMoved(id, x, planY) {
  selId = id; selKind = 'node';
  guarded('moved', () => command({ type: 'NodeMoved', id, x: snap(clampX(x)), y: snap(clampY(planY)) }));
}
// a click in 3D applies the current tool — place / connect / delete / select — just like the 2D canvas
function on3DClick(hit, world) {
  if (placing && world) {
    const x = clampX(snap(world.x)), y = clampY(snap(world.z));
    const ev = placing.fixtureType ? { type: 'NodeAdded', id: uid('n_'), kind: placing.kind, x, y, fixtureType: placing.fixtureType } : { type: 'NodeAdded', id: uid('n_'), kind: placing.kind, x, y };
    const label = placing.label || placing.fixtureType || placing.kind; placing = null;
    return void guarded('placed ' + label, () => command(ev));
  }
  if (tool === 'pipe') {
    if (hit && hit.pick === 'node') {
      if (!pendingFrom) { pendingFrom = hit.id; status('pipe: click the second component'); }
      else if (pendingFrom !== hit.id) { const from = pendingFrom; pendingFrom = null; guarded('pipe routed', () => drawPipe(from, hit.id)); }
      else pendingFrom = null;
    }
    return;
  }
  if (tool === 'delete') {
    if (hit) guarded('deleted', () => command({ type: hit.pick === 'pipe' ? 'PipeRemoved' : 'NodeRemoved', id: hit.id }));
    return;
  }
  on3DSelect(hit ? hit.pick : null, hit ? hit.id : null); // select tool
}
const THREE_OPTS = { onSelect: on3DSelect, onNodeMoved: on3DNodeMoved, onClick: on3DClick, canDragNode: () => tool === 'select' && !placing };

async function setView(v) {
  viewMode = v;
  document.querySelectorAll('.view').forEach((b) => b.classList.toggle('active', b.dataset.view === v));
  render(); // toggles container visibility first
  if (v === '3d') {
    if (!three) {
      status('loading 3D…');
      try { const mod = await import('/three-view.js'); three = mod.mount($('view3d'), THREE_OPTS); window.addEventListener('resize', () => three && three.resize()); status('3D ready — click to select, drag a component to move it'); }
      catch (err) { return void status('3D failed: ' + err.message); }
    }
    three.resize();
    three.update(current); if (three.select) three.select(selId, selKind);
  }
}
document.querySelectorAll('.view').forEach((b) => b.addEventListener('click', () => setView(b.dataset.view)));

$('undo').addEventListener('click', () => guarded('undo', () => api('/api/undo', 'POST').then(render)));
$('redo').addEventListener('click', () => guarded('redo', () => api('/api/redo', 'POST').then(render)));
$('reset').addEventListener('click', () => guarded('reset', () => { underlay = null; planUnderlay = null; ifcMesh = null; ifcFileName = ''; slabCorners = []; selId = null; selKind = null; $('underlayInfo').textContent = ''; return api('/api/reset', 'POST').then(render); }));

/* ---------- import / export / files ---------- */
$('export').addEventListener('click', () => guarded('exported', async () => { const data = await api('/api/export'); const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }); const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'buildgraph-project.json'; a.click(); URL.revokeObjectURL(a.href); }));
/* ---------- project info (report cover metadata) ---------- */
$('projInfo').addEventListener('click', () => {
  const m = current.meta || {};
  $('mTitle').value = m.title || ''; $('mClient').value = m.client || ''; $('mEngineer').value = m.engineer || ''; $('mProjectNo').value = m.projectNo || ''; $('mRevision').value = m.revision || '';
  $('metaModal').hidden = false;
});
$('metaClose').addEventListener('click', () => { $('metaModal').hidden = true; });
$('mSave').addEventListener('click', () => guarded('project info saved', async () => {
  const meta = { title: $('mTitle').value, client: $('mClient').value, engineer: $('mEngineer').value, projectNo: $('mProjectNo').value, revision: $('mRevision').value };
  render(await api('/api/project-meta', 'POST', meta));
  $('metaModal').hidden = true;
}));

$('report').addEventListener('click', () => window.open(withWorkspace('/api/report'), '_blank', 'noopener'));
const boqBtn = $('boqCsv');
if (boqBtn) boqBtn.addEventListener('click', () => window.open(withWorkspace('/api/boq.csv'), '_blank', 'noopener'));
$('import').addEventListener('click', () => $('fileInput').click());
$('fileInput').addEventListener('change', (e) => { if (e.target.files.length) handleFiles(e.target.files, null); e.target.value = ''; });

const wrap = $('canvasWrap');
wrap.addEventListener('dragover', (e) => { e.preventDefault(); if ([...e.dataTransfer.types].includes('Files')) wrap.classList.add('dragover'); });
wrap.addEventListener('dragleave', (e) => { if (e.target === wrap || e.target === $('dropcue')) wrap.classList.remove('dragover'); });
wrap.addEventListener('drop', (e) => { e.preventDefault(); wrap.classList.remove('dragover'); if (e.dataTransfer.files.length) return handleFiles(e.dataTransfer.files, e); const raw = e.dataTransfer.getData('application/x-bg'); if (raw) placeFromPalette(JSON.parse(raw), e.clientX, e.clientY); });

async function handleFiles(files, e) {
  const file = files[0], name = file.name.toLowerCase();
  const cx = e ? e.clientX : 0, cy = e ? e.clientY : 0;
  try {
    if (name.endsWith('.json')) { const parsed = JSON.parse(await file.text()); const events = Array.isArray(parsed) ? parsed : parsed.events; if (!Array.isArray(events)) throw new Error('JSON has no events array'); render(await api('/api/load', 'POST', { events })); status('loaded project: ' + file.name); }
    else if (name.endsWith('.csv')) { const events = csvToFixtureEvents(await file.text()); if (!events.length) throw new Error('no known fixtures in CSV'); render(await command(events)); status(`imported ${events.length} fixtures`); }
    else if (file.type.startsWith('image/')) { const href = await fileToDataUrl(file); underlay = { href, visible: $('underlayToggle').checked, opacity: $('underlayOpacity').value / 100 }; $('underlayInfo').textContent = `underlay: ${file.name}`; render(); status('underlay set'); }
    else if (name.endsWith('.ifc')) {
      status('loading IFC (first load compiles the parser, please wait)…');
      try {
        const buf = await file.arrayBuffer();
        const mod = await import('/ifc.js');
        // Headline: derive a real 2D floor plan (horizontal section cut) to trace MEP over.
        ifcMesh = await mod.extractIfcMesh(buf);
        ifcFileName = file.name;
        await rebuildPlan();
        if (viewMode === '3d') { /* keep 3D */ } else { await setView('schematic'); }
        // Also keep the coloured 3D reference available (initialised in the background, no view flip).
        try {
          const grp = await mod.loadIfc(buf);
          if (!three) { const m3 = await import('/three-view.js'); three = m3.mount($('view3d'), THREE_OPTS); window.addEventListener('resize', () => three && three.resize()); }
          if (three && three.setReference) three.setReference(grp);
        } catch { /* 3D reference is optional */ }
        status(`IFC floor plan ready (${planUnderlay ? planUnderlay.segments.length : 0} lines) — trace your MEP over it`);
      } catch (err) {
        planUnderlay = null; ifcMesh = null;
        $('underlayInfo').textContent = `IFC ${file.name} — could not load (${err.message})`;
        status('IFC load failed: ' + err.message);
      }
    }
    else if (name.endsWith('.dwg') || name.endsWith('.pdf')) { $('underlayInfo').textContent = `attached: ${file.name} (${Math.round(file.size / 1024)} KB) — geometry import coming`; status('attached reference'); }
    else status('unsupported file: ' + file.name);
  } catch (err) { status('import error: ' + err.message); }
}
function csvToFixtureEvents(text) {
  const known = new Set(current.fixtureTypes); const events = []; let i = 0;
  for (const raw of text.split(/\r?\n/)) { const line = raw.trim(); if (!line) continue; const c = line.split(',').map((x) => x.trim()); if (!known.has(c[0])) continue; const x = Number(c[1]), y = Number(c[2]); events.push({ type: 'NodeAdded', id: uid('n_'), kind: 'fixture', x: clampX(Number.isFinite(x) ? x : 4 + (i % 8) * 2), y: clampY(Number.isFinite(y) ? y : 2 + Math.floor(i / 8) * 2.5), fixtureType: c[0] }); i++; }
  return events;
}
const fileToDataUrl = (file) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(file); });

// Re-cut the cached IFC mesh at the current slider height and refresh the plan underlay.
async function rebuildPlan() {
  if (!ifcMesh) return;
  const mod = await import('/ifc.js');
  const cut = $('cutHeight') ? $('cutHeight').value / 100 : 0.5;
  const plan = mod.planFromMesh(ifcMesh, cut, { w: WORLD.w, h: WORLD.h });
  planUnderlay = { segments: plan.segments, visible: $('underlayToggle').checked, opacity: Math.max(0.55, $('underlayOpacity').value / 100) };
  $('underlayInfo').textContent = `IFC plan · ${ifcFileName} · ${plan.segments.length} lines · cut ${Math.round(cut * 100)}% (z=${plan.cutZ.toFixed(2)})`;
  render();
}
$('underlayToggle').addEventListener('change', (e) => { if (underlay) underlay.visible = e.target.checked; if (planUnderlay) planUnderlay.visible = e.target.checked; render(); });
$('underlayOpacity').addEventListener('input', (e) => { const o = e.target.value / 100; if (underlay) underlay.opacity = o; if (planUnderlay) planUnderlay.opacity = Math.max(0.15, o); render(); });
$('cutHeight').addEventListener('input', () => { if (ifcMesh) rebuildPlan(); });

const mediumBtn = $('medium');
if (mediumBtn) { mediumBtn.dataset.medium = pipeMedium; mediumBtn.addEventListener('click', () => { pipeMedium = MEDIA[(MEDIA.indexOf(pipeMedium) + 1) % MEDIA.length]; mediumBtn.textContent = 'medium: ' + pipeMedium; mediumBtn.dataset.medium = pipeMedium; }); }

/* ---------- keyboard ---------- */
document.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
  if (e.key === 'Escape') { if (placing) { placing = null; status('placement cancelled'); } if (activePipeProduct) { activePipeProduct = null; showProductBanner(); } if (pendingFrom) { pendingFrom = null; render(); } if (slabCorners.length) { slabCorners = []; render(); status('slab cancelled'); } return; }
  if (e.key === 'Enter' && tool === 'slab' && slabCorners.length >= 3) { e.preventDefault(); return void commitSlab(); }
  if (e.key === 's' || e.key === 'S') setTool('slab');
  if (e.ctrlKey && e.key.toLowerCase() === 'z') { e.preventDefault(); return $('undo').click(); }
  if (e.ctrlKey && (e.key.toLowerCase() === 'y' || (e.shiftKey && e.key.toLowerCase() === 'z'))) { e.preventDefault(); return $('redo').click(); }
  if (e.key === 'v' || e.key === 'V') setTool('select');
  if (e.key === 'p' || e.key === 'P') setTool('pipe');
  if (e.key === 'd' || e.key === 'D') setTool('delete');
  if ((e.key === 'Delete' || e.key === 'Backspace') && selId) { const ev = selKind === 'pipe' ? { type: 'PipeRemoved', id: selId } : selKind === 'slab' ? { type: 'SlabRemoved', id: selId } : { type: 'NodeRemoved', id: selId }; selId = null; selKind = null; guarded('deleted', () => command(ev)); }
});

/* ---------- component library ---------- */
const lib = { discipline: '', q: '' };
let catalogItems = [];
// Map a fitting/valve catalog name to a compact type code used for its 2D symbol + 3D model.
function fittingCode(name) {
  const n = String(name).toLowerCase();
  if (n.includes('elbow') && n.includes('45')) return 'elbow45';
  if (n.includes('elbow') || n.includes('bend')) return 'elbow90';
  if (n.includes('tee')) return 'tee';
  if (n.includes('cross')) return 'cross';
  if (n.includes('reducer')) return 'reducer';
  if (n.includes('union')) return 'union';
  if (n.includes('cap')) return 'endcap';
  if (n.includes('transition')) return 'transition';
  if (n.includes('valve') || n.includes('gate') || n.includes('ball') || n.includes('check')) return 'valve';
  if (n.includes('coupling') || n.includes('socket')) return 'coupling';
  return 'coupling';
}
// A fitting node stores "type|od" in its fixtureType field (od optional) — parse it back.
function parseFit(raw) { const [type, od] = String(raw || 'coupling').split('|'); return { type, od: od ? Number(od) : null }; }
const fitScale = (od) => Math.max(0.6, Math.min(2.0, (od || 50) / 50)); // visual scale vs a Ø50 reference
function catalogToPlacement(it) {
  if (it.category === 'fixture' && CAT_FIX[it.name] && (current.fixtureTypes || []).includes(CAT_FIX[it.name])) return { kind: 'fixture', fixtureType: CAT_FIX[it.name] };
  if (it.category === 'equipment' && /tank/i.test(it.name)) return { kind: 'source' };
  if (it.category === 'fitting' || it.category === 'valve' || it.category === 'drain-fitting') { const od = Number(it.spec && it.spec.odMm) || 0; return { kind: 'fitting', fixtureType: fittingCode(it.name) + (od ? '|' + od : ''), label: it.name }; }
  return null;
}
function catalogToPipeProduct(it) {
  if (it.category === 'pipe') return { name: it.name, material: it.spec.material || 'PPR-R', odMm: Number(it.spec.odMm), pn: it.spec.pn, price: it.price, system: 'supply' };
  if (it.category === 'drain-pipe') return { name: it.name, material: it.spec.material || 'uPVC', odMm: Number(it.spec.odMm), price: it.price, system: 'drainage' };
  return null;
}
function showProductBanner() {
  const el = $('activeProduct');
  if (!el) return;
  if (!activePipeProduct) { el.hidden = true; el.innerHTML = ''; return; }
  el.hidden = false;
  el.innerHTML = `Drawing with <b>${esc(activePipeProduct.name)}</b> <button id="clearProduct">clear ✕</button>`;
  $('clearProduct').addEventListener('click', () => { activePipeProduct = null; showProductBanner(); status('cleared active pipe product'); });
}
async function loadCatalog() {
  const params = new URLSearchParams();
  if (lib.discipline) params.set('discipline', lib.discipline);
  if (lib.q) params.set('q', lib.q);
  const data = await api('/api/catalog?' + params.toString());
  catalogItems = data.items;
  const sel = $('libDiscipline');
  if (sel.options.length <= 1) for (const d of data.disciplines) { const o = document.createElement('option'); o.value = d; o.textContent = d; sel.appendChild(o); }
  $('libCount').textContent = `${data.items.length} of ${data.total} components`;
  const byCat = {};
  for (const it of data.items) (byCat[it.category] ??= []).push(it);
  const cats = Object.keys(byCat).sort();
  $('libList').innerHTML = cats.map((c) => `<div class="lib-cat"><h3>${esc(c)} <span>${esc(byCat[c].length)}</span></h3><div class="lib-items">${byCat[c].map(libRow).join('')}</div></div>`).join('') || '<p class="hint">no components match</p>';
}
function libRow(it) {
  const specs = Object.entries(it.spec ?? {}).map(([k, v]) => `${esc(k)}: ${esc(v)}`).join(' · ');
  const price = it.price != null ? `<span class="lib-price">${esc(it.price)}</span>` : '';
  const placeBtn = catalogToPlacement(it) ? `<button class="lib-place" data-id="${esc(it.id)}">Place on plan</button>` : '';
  const useBtn = catalogToPipeProduct(it) ? `<button class="lib-use" data-id="${esc(it.id)}">Use this pipe</button>` : '';
  return `<div class="lib-item ${it.custom ? 'custom' : ''}"><div class="lib-name">${esc(it.name)}${it.custom ? ' <em>(yours)</em>' : ''}</div><div class="lib-spec">${specs}</div><div class="lib-meta"><span>${esc(it.discipline)} · per ${esc(it.unit)}</span>${price}</div>${placeBtn}${useBtn}</div>`;
}
$('libList').addEventListener('click', (e) => {
  const placeB = e.target.closest('.lib-place');
  const useB = e.target.closest('.lib-use');
  if (placeB) {
    const it = catalogItems.find((x) => x.id === placeB.dataset.id);
    const pl = it && catalogToPlacement(it);
    if (!pl) return;
    placing = pl;
    $('libraryModal').hidden = true;
    status('click on the plan (2D or 3D) to place ' + (pl.label || pl.fixtureType || pl.kind) + ' (Esc to cancel)');
  } else if (useB) {
    const it = catalogItems.find((x) => x.id === useB.dataset.id);
    const pp = it && catalogToPipeProduct(it);
    if (!pp) return;
    const product = { name: pp.name, material: pp.material, odMm: pp.odMm, pn: pp.pn, price: pp.price };
    $('libraryModal').hidden = true;
    if (selKind === 'pipe' && selId) {
      guarded('applied ' + product.name, () => command({ type: 'PipeProductSet', id: selId, product }));
    } else {
      activePipeProduct = product;
      pipeMedium = pp.system === 'drainage' ? 'drainage' : (pipeMedium === 'cold' || pipeMedium === 'hot' ? pipeMedium : 'cold');
      if (mediumBtn) { mediumBtn.textContent = 'medium: ' + pipeMedium; mediumBtn.dataset.medium = pipeMedium; }
      setTool('pipe');
      showProductBanner();
      status('drawing with ' + product.name + ' — click two points (Esc to clear)');
    }
  }
});
$('library').addEventListener('click', () => { $('libraryModal').hidden = false; loadCatalog().catch((e) => status('catalog: ' + e.message)); });
$('libClose').addEventListener('click', () => { $('libraryModal').hidden = true; });
$('libraryModal').addEventListener('click', (e) => { if (e.target === $('libraryModal')) $('libraryModal').hidden = true; });
$('libDiscipline').addEventListener('change', (e) => { lib.discipline = e.target.value; loadCatalog(); });
$('libSearch').addEventListener('input', (e) => { lib.q = e.target.value; loadCatalog(); });
$('libAddToggle').addEventListener('click', () => { const f = $('libAddForm'); f.hidden = !f.hidden; });
$('libAddForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  let spec = {};
  const specRaw = (fd.get('spec') || '').toString().trim();
  if (specRaw) { try { spec = JSON.parse(specRaw); } catch { return void status('spec must be valid JSON'); } }
  const body = { discipline: fd.get('discipline'), category: fd.get('category'), name: fd.get('name'), spec, unit: fd.get('unit') || 'nr', price: fd.get('price') ? Number(fd.get('price')) : undefined };
  guarded('added to library', async () => { await api('/api/catalog', 'POST', body); e.target.reset(); $('libAddForm').hidden = true; await loadCatalog(); });
});

/* ---------- projects (save / open on the server) ---------- */
let currentProject = null;
async function loadProjects() {
  const data = await api('/api/projects');
  $('projList').innerHTML = data.projects.map((p) => `<div class="proj-row"><div><b>${esc(p.name)}</b><div class="hint">${esc(p.eventCount)} edits${p.savedAt ? ' · ' + esc(new Date(p.savedAt).toLocaleString()) : ''}</div></div><div class="proj-actions"><button class="proj-open" data-name="${esc(encodeURIComponent(p.name))}">Open</button><button class="proj-del ghost" data-name="${esc(encodeURIComponent(p.name))}">Delete</button></div></div>`).join('') || '<p class="hint">no saved projects yet — name one above and Save current</p>';
}
$('projects').addEventListener('click', () => { $('projectsModal').hidden = false; if (currentProject) $('projName').value = currentProject; loadProjects().catch((e) => status('projects: ' + e.message)); });
$('projClose').addEventListener('click', () => { $('projectsModal').hidden = true; });
$('projectsModal').addEventListener('click', (e) => { if (e.target === $('projectsModal')) $('projectsModal').hidden = true; });
$('projSave').addEventListener('click', () => {
  const name = $('projName').value.trim();
  if (!name) { status('enter a project name first'); return; }
  guarded('saved "' + name + '"', async () => { await api('/api/project/save', 'POST', { name }); currentProject = name; await loadProjects(); });
});
$('projList').addEventListener('click', (e) => {
  const open = e.target.closest('.proj-open'), del = e.target.closest('.proj-del');
  if (open) { const name = decodeURIComponent(open.dataset.name); guarded('opened "' + name + '"', async () => { render(await api('/api/project/load', 'POST', { name })); currentProject = name; $('projectsModal').hidden = true; }); }
  else if (del) { const name = decodeURIComponent(del.dataset.name); guarded('deleted "' + name + '"', async () => { await api('/api/project/delete', 'POST', { name }); await loadProjects(); }); }
});

/* ---------- assist (deterministic auto-design) ---------- */
$('assist').addEventListener('click', () => { const m = $('assistMenu'); m.hidden = !m.hidden; });
$('pressure').addEventListener('click', togglePressureMode);
$('assistMenu').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-act]');
  if (!b) return;
  $('assistMenu').hidden = true;
  const act = b.dataset.act;
  const applied = (state) => { render(state); if (state && state.notice) status(state.notice); return state; };
  if (act === 'fix-slopes') return void guarded('slopes checked', () => api('/api/fix-slopes', 'POST').then(applied));
  const medium = act === 'route-hot' ? 'hot' : act === 'route-drain' ? 'drainage' : act === 'route-vent' ? 'vent' : act === 'route-power' ? 'power' : act === 'route-air' ? 'air' : 'cold';
  guarded('auto-route ' + medium, () => api('/api/autoroute', 'POST', { medium }).then(applied));
});
document.addEventListener('click', (e) => { if (!e.target.closest('#assist') && !e.target.closest('#assistMenu')) $('assistMenu').hidden = true; });

/* ---------- grounded assistant ---------- */
function askAppend(who, text) {
  const log = $('askLog');
  const d = document.createElement('div');
  d.className = 'ask-msg ' + who;
  d.textContent = text;
  log.appendChild(d);
  log.scrollTop = log.scrollHeight;
  return d;
}
async function ask(question) {
  if (!question.trim()) return;
  askAppend('user', question);
  const pending = askAppend('bot', aiEnabled ? 'thinking…' : '…');
  pending.classList.add('pending');
  try {
    const data = await api('/api/ask', 'POST', { question, selectedPipeId: selKind === 'pipe' ? selId : undefined });
    pending.classList.remove('pending');
    pending.textContent = data.answer;
    const tag = document.createElement('span');
    tag.className = 'ask-mode';
    tag.textContent = data.mode === 'ai' ? 'AI · grounded' : 'grounded engine';
    pending.appendChild(tag);
  } catch (e) {
    pending.classList.remove('pending');
    pending.textContent = 'error: ' + (e.message || e);
  }
  $('askLog').scrollTop = $('askLog').scrollHeight;
}
$('ask').addEventListener('click', () => {
  $('assistantModal').hidden = false;
  if (!$('askLog').childElementCount) askAppend('bot', aiEnabled
    ? 'Hi — I’m your AI design copilot. Ask me anything about this project in plain language. Every figure I give comes straight from the engine (select a pipe first for “why this size?”).'
    : 'Hi — ask me about your design. I answer with numbers straight from the engine (select a pipe first for “why this size?”).');
  $('askInput').focus();
});
$('askClose').addEventListener('click', () => { $('assistantModal').hidden = true; });
$('assistantModal').addEventListener('click', (e) => { if (e.target === $('assistantModal')) $('assistantModal').hidden = true; });
$('askForm').addEventListener('submit', (e) => { e.preventDefault(); const v = $('askInput').value; $('askInput').value = ''; guarded('asked', () => ask(v)); });
document.querySelectorAll('.ask-suggest button').forEach((b) => b.addEventListener('click', () => guarded('asked', () => ask(b.dataset.q))));

/* ---------- jurisdiction switch ---------- */
async function loadJurisdictions() {
  const data = await api('/api/jurisdictions');
  const sel = $('jurisdictionSel');
  sel.innerHTML = data.jurisdictions.map((j) => `<option value="${esc(j.id)}" ${j.id === data.active ? 'selected' : ''}>${esc(j.id)}</option>`).join('');
  aiEnabled = !!data.ai;
  const sub = document.querySelector('#assistantModal .modal-head .hint');
  if (sub) sub.textContent = aiEnabled
    ? 'Live AI copilot — free-form questions, grounded in your model (every number is engine-computed, never guessed).'
    : 'Grounded assistant — deterministic, engine-computed answers. Set ANTHROPIC_API_KEY to enable the live AI copilot.';
}
$('jurisdictionSel').addEventListener('change', (e) => guarded('jurisdiction → ' + e.target.value, () => api('/api/jurisdiction', 'POST', { id: e.target.value }).then(render)));

/* ---------- live collaboration (Server-Sent Events) ---------- */
let liveSource = null;
// Apply a collaborator's state — but never mid-drag (would fight the pointer); defer until pointerup.
function applyRemote() {
  if (!pendingRemote || drag) return;
  const state = pendingRemote; pendingRemote = null;
  render(state);
  status('↺ updated by a collaborator');
}
function connectLiveSync() {
  if (liveSource) { liveSource.close(); liveSource = null; }
  if (!activeWorkspaceId) return;

  const es = new EventSource(withWorkspace(`/api/events?client=${encodeURIComponent(clientId)}`));
  liveSource = es;
  es.onmessage = (ev) => {
    let msg; try { msg = JSON.parse(ev.data); } catch { return; }
    if (!msg || !msg.state || msg.origin === clientId) return; // ignore the echo of our own edits
    pendingRemote = msg.state;
    applyRemote();
  };
  // The owner removed us from this workspace: stop retrying and fall back to our own.
  es.addEventListener('revoked', () => { es.close(); liveSource = null; status('your access to this workspace was removed'); void refreshWorkspaces(); });
  es.onerror = () => status('live sync reconnecting…'); // EventSource retries on its own
}


/* ---------- accounts ----------
 * The gate is shown until /api/auth/me reports a session, and shown again if one expires mid-edit.
 * It is a convenience only: the server rejects every unauthenticated call regardless of what the
 * page chooses to display. */
let authFormMode = 'signin';

function setAuthMode(mode) {
  authFormMode = mode;
  $('tabSignIn').classList.toggle('active', mode === 'signin');
  $('tabRegister').classList.toggle('active', mode === 'register');
  $('authSubmit').textContent = mode === 'signin' ? 'Sign in' : 'Create account';
  $('authPass').setAttribute('autocomplete', mode === 'signin' ? 'current-password' : 'new-password');
  $('authHint').textContent = mode === 'signin'
    ? 'Use the account you created on this server.'
    : 'Choose a password of at least 10 characters. It is hashed with scrypt and never stored in the clear.';
  $('authError').hidden = true;
}

function openAuthGate(message) {
  account = null;
  if (liveSource) { liveSource.close(); liveSource = null; }
  $('authGate').hidden = false;
  $('tabRegister').hidden = !allowRegistration;
  if (message) { $('authError').textContent = message; $('authError').hidden = false; }
  $('authUser').focus();
}

function closeAuthGate() {
  $('authGate').hidden = true;
  $('authError').hidden = true;
  $('authForm').reset();
}

$('tabSignIn').addEventListener('click', () => setAuthMode('signin'));
$('tabRegister').addEventListener('click', () => setAuthMode('register'));

$('authForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const submit = $('authSubmit');
  submit.disabled = true;
  $('authError').hidden = true;
  try {
    const body = { username: $('authUser').value, password: $('authPass').value };
    const data = await api(authFormMode === 'signin' ? '/api/auth/login' : '/api/auth/register', 'POST', body);
    account = data.user;
    closeAuthGate();
    await startSession();
  } catch (err) {
    if (err.message !== 'signed out') { $('authError').textContent = err.message; $('authError').hidden = false; }
  } finally {
    submit.disabled = false;
  }
});

$('accountBtn').addEventListener('click', () => {
  if (!account) return void openAuthGate();
  $('accountWho').textContent = `Signed in as ${account.displayName || account.username}`;
  $('passwordForm').hidden = authMode === 'open';
  $('accountModal').hidden = false;
});
$('accountClose').addEventListener('click', () => { $('accountModal').hidden = true; });
$('accountModal').addEventListener('click', (e) => { if (e.target === $('accountModal')) $('accountModal').hidden = true; });

$('passwordForm').addEventListener('submit', (e) => {
  e.preventDefault();
  guarded('password changed', async () => {
    await api('/api/auth/password', 'POST', { currentPassword: $('pwCurrent').value, newPassword: $('pwNew').value });
    e.target.reset();
    $('accountModal').hidden = true;
  });
});

$('logoutBtn').addEventListener('click', () => guarded('signed out', async () => {
  await api('/api/auth/logout', 'POST');
  $('accountModal').hidden = true;
  openAuthGate('Signed out.');
}));

/* ---------- workspaces ----------
 * A workspace is one drawing plus its saved projects, its component library and its collaborators.
 * Switching reconnects the live stream and reloads the model. */
const activeWorkspace = () => workspaces.find((w) => w.id === activeWorkspaceId) || null;

function renderWorkspaceButton() {
  const ws = activeWorkspace();
  $('workspaceBtn').textContent = ws ? `◨ ${ws.name}` : '◨ Workspace';
  $('workspaceBtn').title = ws
    ? `${ws.name} — you are the ${ws.role}${ws.members.length ? `, ${ws.members.length} collaborator(s)` : ''}`
    : 'Workspaces and collaborators';
}

async function refreshWorkspaces() {
  const data = await api('/api/workspaces');
  workspaces = data.workspaces;
  if (!workspaces.some((w) => w.id === activeWorkspaceId)) {
    activeWorkspaceId = data.active || (workspaces[0] && workspaces[0].id) || null;
  }
  renderWorkspaceButton();
  return workspaces;
}

function renderWorkspaceModal() {
  $('wsList').innerHTML = workspaces.map((w) => `
    <div class="ws-row ${w.id === activeWorkspaceId ? 'active' : ''}">
      <div><b>${esc(w.name)}</b><div class="hint">${esc(w.role === 'owner' ? 'You own this' : `Shared by ${w.owner ? w.owner.displayName : 'another engineer'}`)}</div></div>
      <div class="proj-actions">
        <span class="ws-role">${esc(w.role)}</span>
        ${w.id === activeWorkspaceId ? '<span class="badge ok">open</span>' : `<button class="ws-open" data-id="${esc(w.id)}">Open</button>`}
      </div>
    </div>`).join('') || '<p class="hint">no workspaces yet</p>';

  const ws = activeWorkspace();
  if (!ws) { $('wsMembers').innerHTML = ''; return; }

  const rows = ws.members.map((m) => `
    <div class="ws-member"><span>${esc(m.displayName || m.username)} <span class="hint">@${esc(m.username)}</span></span>
    ${ws.role === 'owner' ? `<button class="ws-remove ghost" data-id="${esc(m.id)}">Remove</button>` : ''}</div>`).join('');

  $('wsMembers').innerHTML = `
    <div class="fix-title">Collaborators on ${esc(ws.name)}</div>
    ${rows || '<p class="hint" style="margin:6px 0 0">Only you. Invite someone by their username and you will both edit this drawing live.</p>'}
    ${ws.role === 'owner'
      ? `<div class="ws-invite"><input id="wsInvite" placeholder="username to invite…" maxlength="32" /><button id="wsAdd" class="primary">Invite</button></div>
         <div class="ws-invite"><input id="wsRename" value="${esc(ws.name)}" maxlength="60" /><button id="wsRenameBtn">Rename</button></div>`
      : '<p class="hint" style="margin-top:8px">Only the owner can invite or remove collaborators.</p>'}`;

  const add = $('wsAdd');
  if (add) add.addEventListener('click', () => guarded('invited', async () => {
    await api('/api/workspace/members', 'POST', { username: $('wsInvite').value });
    await refreshWorkspaces();
    renderWorkspaceModal();
  }));

  const rename = $('wsRenameBtn');
  if (rename) rename.addEventListener('click', () => guarded('renamed', async () => {
    await api('/api/workspace/rename', 'POST', { name: $('wsRename').value });
    await refreshWorkspaces();
    renderWorkspaceModal();
  }));
}

$('wsList').addEventListener('click', (e) => {
  const open = e.target.closest('.ws-open');
  if (!open) return;
  guarded('workspace opened', () => switchWorkspace(open.dataset.id));
  $('workspaceModal').hidden = true;
});

$('wsMembers').addEventListener('click', (e) => {
  const remove = e.target.closest('.ws-remove');
  if (!remove) return;
  guarded('collaborator removed', async () => {
    await api('/api/workspace/members/remove', 'POST', { userId: remove.dataset.id });
    await refreshWorkspaces();
    renderWorkspaceModal();
  });
});

$('workspaceBtn').addEventListener('click', () => guarded('workspaces', async () => {
  await refreshWorkspaces();
  renderWorkspaceModal();
  $('workspaceModal').hidden = false;
}));
$('wsClose').addEventListener('click', () => { $('workspaceModal').hidden = true; });
$('workspaceModal').addEventListener('click', (e) => { if (e.target === $('workspaceModal')) $('workspaceModal').hidden = true; });

$('wsCreate').addEventListener('click', () => guarded('workspace created', async () => {
  const name = $('wsNewName').value.trim();
  if (!name) throw new Error('name the workspace first');
  const ws = await api('/api/workspaces', 'POST', { name });
  $('wsNewName').value = '';
  await refreshWorkspaces();
  await switchWorkspace(ws.id);
  renderWorkspaceModal();
}));

async function switchWorkspace(id) {
  activeWorkspaceId = id;
  selId = null; selKind = null; currentProject = null;
  underlay = null; planUnderlay = null; ifcMesh = null;
  renderWorkspaceButton();
  connectLiveSync();
  render(await api('/api/state'));
  await loadJurisdictions();
}

/* ---------- start-up ---------- */
async function startSession() {
  await refreshWorkspaces();
  connectLiveSync();
  render(await api('/api/state'));
  await loadJurisdictions();
  status('ready');
}

async function boot() {
  let me;
  try {
    me = await fetch('/api/auth/me', { credentials: 'same-origin' }).then((r) => r.json());
  } catch {
    status('cannot reach the server');
    return;
  }
  authMode = me.authMode;
  allowRegistration = !!me.allowRegistration;
  account = me.user;

  if (authMode === 'open') $('accountBtn').hidden = true;
  setAuthMode('signin');

  if (!account && authMode === 'accounts') { openAuthGate(); return; }
  guarded('ready', startSession);
}

boot();
