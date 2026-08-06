import { round } from '@buildgraph/engineering-core';
import type { BoqDto, NodeDto, PipeDto, SlabDto, StateSnapshot } from '../model/serialize.ts';

/**
 * The submittal-quality design report.
 *
 * Every dynamic value passes through `esc` on its way into the document — including numbers, which
 * cost nothing to escape and remove the need to reason about which fields happen to be numeric
 * today. The model's own validation already refuses markup in identifiers and type names; this is
 * the second, independent layer, so a change to either one alone cannot open a hole.
 */

const REPORT_STYLES = `
  :root{--ink:#14181d;--muted:#667085;--line:#e2e6ec;--accent:#1f6feb;--ok:#12805c;--bad:#c0362c}
  *{box-sizing:border-box}
  body{font:13.5px/1.55 system-ui,"Segoe UI",Roboto,sans-serif;color:var(--ink);max-width:940px;margin:0 auto;padding:28px 26px 60px}
  .cover{border:1px solid var(--line);border-radius:14px;padding:22px 24px;background:linear-gradient(180deg,#f7faff,#fff)}
  .cover h1{font-size:25px;margin:0 0 2px;color:var(--accent)}
  .cover .kicker{font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:var(--muted);font-weight:700}
  .grid{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-top:16px}
  .kpi{background:#fff;border:1px solid var(--line);border-radius:10px;padding:10px 12px}
  .kpi .k{font-size:10px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted)}
  .kpi .v{font-size:20px;font-weight:700;font-family:ui-monospace,monospace}
  .row{display:flex;justify-content:space-between;align-items:flex-end;gap:16px;flex-wrap:wrap}
  .meta{color:var(--muted);font-size:12px;margin:6px 0 0}
  h2{font-size:13px;text-transform:uppercase;letter-spacing:.05em;color:var(--accent);margin:30px 0 8px;border-bottom:2px solid var(--line);padding-bottom:5px}
  h2 .sub2{color:var(--muted);text-transform:none;letter-spacing:0;font-weight:400;font-size:11px}
  h3{font-size:12px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em;margin:16px 0 6px}
  table{width:100%;border-collapse:collapse;font-size:12.5px;margin-top:4px}
  th{text-align:left;color:var(--muted);font-size:10px;text-transform:uppercase;border-bottom:1px solid var(--line);padding:6px 7px}
  td{padding:6px 7px;border-bottom:1px solid var(--line)}
  td.num,th.num{font-family:ui-monospace,monospace;text-align:right}
  .ok{color:var(--ok);font-weight:600}
  .bad{color:var(--bad);font-weight:600}
  .good{color:var(--ok);background:#eafaf2;border:1px solid #bfe6d1;border-radius:8px;padding:10px 12px;font-size:12.5px}
  tr.grp td{font-weight:700;background:#f4f7fb}
  tr.sub td{color:var(--muted);font-size:11.5px}
  tr.sub td:first-child{text-align:right}
  tr.total td{border-top:2px solid var(--accent);font-size:14px}
  .disc{background:#fbf6e9;border:1px solid #efe0b8;border-radius:10px;padding:12px 14px;font-size:12px;color:#6b5a1e;margin-top:12px}
  .foot{margin-top:22px;color:var(--muted);font-size:11px;border-top:1px solid var(--line);padding-top:10px}
  button{font:inherit;background:var(--accent);color:#fff;border:0;border-radius:8px;padding:9px 16px;cursor:pointer}
  @media print{.noprint{display:none}body{margin:0;padding:0}h2{break-after:avoid}table{break-inside:auto}tr{break-inside:avoid}}
`;

/**
 * The report's only script. It is served with a CSP that allows exactly this source by hash, so an
 * inline event handler (which would need `unsafe-inline`) is not required.
 */
export const REPORT_SCRIPT = `document.getElementById('printReport').addEventListener('click',function(){window.print()});`;

/** HTML-escape any value, including the five characters that matter inside attributes. */
function esc(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}

const dash = (value: unknown): string => (value === null || value === undefined ? '—' : esc(value));
/** "WaterCloset" reads as "Water Closet" in a document a client will see. */
const humanise = (value: unknown): string => String(value ?? '').replace(/([a-z])([A-Z])/g, '$1 $2');

interface Column { h: string; n?: boolean }

const table = (columns: Column[], rows: string): string =>
  `<table><thead><tr>${columns.map((c) => `<th${c.n ? ' class="num"' : ''}>${esc(c.h)}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table>`;

const section = (title: string, note: string, body: string): string =>
  (body ? `<h2>${esc(title)}${note ? ` <span class="sub2">${esc(note)}</span>` : ''}</h2>${body}` : '');

const status = (ok: boolean): string => (ok ? '<span class="ok">✓ OK</span>' : '<b class="bad">✗ CHECK</b>');

const pipeOk = (p: PipeDto): boolean => p.sizePass !== false && p.velocityPass !== false && p.slopePass !== false;

export function buildReportHtml(state: StateSnapshot, workspaceName: string): string {
  const { nodes, pipes } = state;
  const slabs = state.slabs ?? [];
  const byMedium = (m: string | string[]): PipeDto[] => pipes.filter((p) => (Array.isArray(m) ? m.includes(p.medium) : p.medium === m));

  const findings = collectFindings(state);
  const compliance = findings.length > 0
    ? table([{ h: 'Discipline' }, { h: 'Tag' }, { h: 'Finding' }],
      findings.map((f) => `<tr><td>${esc(f.discipline)}</td><td>${esc(f.tag)}</td><td class="bad">${esc(f.issue)}</td></tr>`).join(''))
    : '<p class="good">No outstanding issues — every sized element passes its code checks under the current jurisdiction.</p>';

  const supply = byMedium(['cold', 'hot']);
  const drain = byMedium('drainage');
  const vent = byMedium('vent');
  const power = byMedium('power');
  const air = byMedium('air');
  const beams = byMedium('beam');
  const columns = nodes.filter((n) => n.kind === 'support' && n.column !== null);
  const fixtures = nodes.filter((n) => n.kind === 'fixture');
  const fittings = nodes.filter((n) => n.kind === 'fitting');

  const disciplines = [
    supply.length > 0 && 'Plumbing (supply)',
    drain.length > 0 && 'Drainage',
    vent.length > 0 && 'Vent',
    power.length > 0 && 'Electrical',
    air.length > 0 && 'HVAC',
    (beams.length > 0 || columns.length > 0 || slabs.length > 0) && 'Structural',
  ].filter(Boolean).join(' · ') || '—';

  const meta = state.meta ?? {};
  const title = meta.title || workspaceName;
  const metaBits = [
    meta.client && `Client: ${meta.client}`,
    meta.engineer && `Engineer: ${meta.engineer}`,
    meta.projectNo && `Project No. ${meta.projectNo}`,
    meta.revision && `Rev. ${meta.revision}`,
  ].filter(Boolean) as string[];

  const structural = [
    section('Beams', '', beamTable(beams)),
    section('Columns', '', columnTable(columns)),
    section('Slabs', '', slabTable(slabs)),
  ].join('');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Design Report — ${esc(title)}</title>
<style>${REPORT_STYLES}</style>
</head>
<body>
  <div class="cover">
    <div class="row">
      <div>
        <div class="kicker">Engineering Design Report</div>
        <h1>MEP &amp; Structural — ${esc(title)}</h1>
        <p class="meta">Jurisdiction <b>${esc(state.jurisdiction)}</b> · Disciplines: ${esc(disciplines)} · Generated ${esc(new Date().toISOString().replace('T', ' ').slice(0, 16))} UTC</p>
        ${metaBits.length > 0 ? `<p class="meta">${metaBits.map(esc).join(' &nbsp;·&nbsp; ')}</p>` : ''}
      </div>
      <button class="noprint" id="printReport">Print / Save PDF</button>
    </div>
    <div class="grid">
      <div class="kpi"><div class="k">Fixtures</div><div class="v">${esc(fixtures.length)}</div></div>
      <div class="kpi"><div class="k">Runs / members</div><div class="v">${esc(pipes.length)}</div></div>
      <div class="kpi"><div class="k">Items to check</div><div class="v ${findings.length > 0 ? 'bad' : 'ok'}">${esc(findings.length)}</div></div>
      <div class="kpi"><div class="k">Project total</div><div class="v">${esc(state.costTotal ?? 0)}</div></div>
    </div>
  </div>

  <h2>1 · Cost summary by discipline</h2>
  ${costSummary(state)}

  <h2>2 · Code compliance register</h2>
  ${compliance}

  ${section('3 · Plumbing — supply', 'Hunter demand · Hazen–Williams', supplyTable(supply))}
  ${section('4 · Plumbing — pressure balance', 'network solver · residual at every outlet', pressureTable(state))}
  ${section('4b · Hot-water recirculation', 'loop pump head · balancing valves', recircTable(state))}
  ${section('5 · Plumbing — drainage (gravity)', 'DFU sizing · Manning self-cleansing', drainTable(drain))}
  ${section('5b · Drainage &amp; vent — network validation', 'connectivity · DFU load', dwvTable(state))}
  ${section('6 · Plumbing — vent', 'DFU-based sizing', ventTable(vent))}
  ${section('7 · Electrical — cables', 'ampacity + voltage drop', powerTable(power))}
  ${section('8 · HVAC — ducts', 'velocity method', airTable(air))}
  ${structural ? `<h2>9 · Structural (reinforced concrete)</h2>${structural}` : ''}
  ${section('10 · Pipe fittings', '', fittingTable(fittings))}
  ${section('11 · Fixture schedule', '', fixtureTable(fixtures))}

  <h2>12 · Bill of Quantities <span class="sub2">unit rates are representative and require verification</span></h2>
  ${boqTable(state)}

  <div class="disc">
    <b>Decision-support output — not for construction.</b> All sizes, quantities and rates are
    preliminary and subject to review, analysis and sign-off by the Engineer of Record. Engineering
    constants and unit rates are representative pending confirmation against the adopted code and a
    current regional cost database.
  </div>
  <div class="foot">
    Generated by BuildGraph Studio. Every value in this document is computed by the deterministic
    engineering rules engine from the model as drawn; no figure is estimated. Jurisdiction
    ${esc(state.jurisdiction)}.
  </div>
<script>${REPORT_SCRIPT}</script>
</body>
</html>`;
}

/* ------------------------------------------------------------ compliance */

interface Finding { discipline: string; tag: string; issue: string }

function collectFindings(state: StateSnapshot): Finding[] {
  const findings: Finding[] = [];

  for (const p of state.pipes) {
    if (pipeOk(p)) continue;
    const issue = p.slopePass === false ? 'below minimum self-cleansing slope'
      : p.velocityPass === false ? 'velocity outside the permitted range'
        : p.sizeOd === null ? 'no catalogue size satisfies the constraints'
          : 'size check required';
    findings.push({ discipline: p.medium, tag: p.id, issue });
  }
  for (const p of state.pipes) {
    if (p.medium !== 'drainage') continue;
    if (p.isStack && p.branchPass === false) {
      findings.push({ discipline: 'drainage', tag: p.id, issue: `${p.perIntervalDfu} DFU at a branch interval exceeds the Ø${p.sizeOd} stack limit of ${p.branchLimit} DFU` });
    }
    if (p.isOffset) {
      findings.push({ discipline: 'drainage', tag: p.id, issue: 'stack offset — size and fixture-connection restrictions apply; verify against the offset rules' });
    }
  }
  for (const n of state.nodes) {
    if (n.kind === 'support' && n.column !== null && n.column.pass === false) {
      findings.push({ discipline: 'structural', tag: n.id, issue: 'column over capacity — no catalogue section fits' });
    }
  }
  for (const sl of state.slabs ?? []) {
    if (sl.pass === false) findings.push({ discipline: 'structural', tag: sl.id, issue: 'slab span exceeds the catalogue thickness range' });
  }

  const pressure = state.pressure as { hasSource?: boolean; fixtures?: { id: string; residualKPa: number; pass: boolean; over: boolean }[]; minResidualKPa?: number; maxPressureKPa?: number } | null;
  if (pressure?.hasSource) {
    for (const f of pressure.fixtures ?? []) {
      if (f.over) findings.push({ discipline: 'plumbing', tag: f.id, issue: `residual ${f.residualKPa} kPa exceeds the ${pressure.maxPressureKPa} kPa maximum — a pressure-reducing valve is required` });
      else if (!f.pass) findings.push({ discipline: 'plumbing', tag: f.id, issue: `residual ${f.residualKPa} kPa is below the ${pressure.minResidualKPa} kPa minimum` });
    }
  }

  const dwv = state.dwv as { active?: boolean; unconnectedDrains?: string[]; unventedFixtures?: string[] } | null;
  if (dwv?.active) {
    for (const id of dwv.unconnectedDrains ?? []) findings.push({ discipline: 'drainage', tag: id, issue: 'fixture has no drainage path to the sewer outlet' });
    for (const id of dwv.unventedFixtures ?? []) findings.push({ discipline: 'vent', tag: id, issue: 'trap is not connected to a vent — siphonage risk' });
  }
  return findings;
}

/* -------------------------------------------------------------- schedules */

function supplyTable(pipes: PipeDto[]): string {
  if (pipes.length === 0) return '';
  return table(
    [{ h: 'Tag' }, { h: 'System' }, { h: 'Item' }, { h: 'Ø (mm)', n: true }, { h: 'Length (m)', n: true }, { h: 'Demand (L/s)', n: true }, { h: 'Velocity (m/s)', n: true }, { h: 'Head loss (m)', n: true }, { h: 'Status' }],
    pipes.map((p) => {
      const product = p.product as { name?: string } | null;
      return `<tr><td>${esc(p.id)}</td><td>${esc(p.medium)}</td><td>${esc(product?.name ?? 'PPR')}</td><td class="num">${dash(p.sizeOd)}</td><td class="num">${esc(p.lengthM)}</td><td class="num">${dash(p.demandLps)}</td><td class="num">${dash(p.velocityMs)}</td><td class="num">${dash(p.headlossM)}</td><td>${status(pipeOk(p))}</td></tr>`;
    }).join(''),
  );
}

function pressureTable(state: StateSnapshot): string {
  const pr = state.pressure as {
    hasSource?: boolean; fixtures?: { id: string; type: string; residualKPa: number; pass: boolean; over: boolean }[];
    supplyPressureKPa?: number; minResidualKPa?: number; maxPressureKPa?: number;
    worst?: { id: string; type: string; residualKPa: number } | null; totalFrictionM?: number;
    minorToCriticalM?: number; criticalFittings?: number;
  } | null;
  if (!pr?.hasSource || (pr.fixtures ?? []).length === 0) return '';

  const rows = [...(pr.fixtures ?? [])]
    .sort((a, b) => a.residualKPa - b.residualKPa)
    .map((f) => `<tr><td>${esc(f.id)}</td><td>${esc(humanise(f.type))}</td><td class="num">${esc(f.residualKPa)}</td><td>${f.over ? '<b class="bad">✗ over — PRV</b>' : status(f.pass)}</td></tr>`)
    .join('');
  const worst = pr.worst ? `${esc(humanise(pr.worst.type))} (${esc(pr.worst.id)}) at ${esc(pr.worst.residualKPa)} kPa` : '—';
  const note = `<p class="meta">Source supply <b>${esc(pr.supplyPressureKPa)} kPa</b> · code residual minimum <b>${esc(pr.minResidualKPa)} kPa</b> / maximum <b>${esc(pr.maxPressureKPa)} kPa</b>. Governing outlet: <b>${worst}</b>; total head loss to it <b>${esc(pr.totalFrictionM)} m</b>, of which <b>${esc(pr.minorToCriticalM)} m</b> from ${esc(pr.criticalFittings)} fitting(s). Residual = supply pressure + static (elevation) head − Hazen–Williams pipe friction − fitting minor losses (K·v²/2g); velocity head is excluded.</p>`;
  return note + table([{ h: 'Tag' }, { h: 'Fixture' }, { h: 'Residual (kPa)', n: true }, { h: 'Status' }], rows);
}

function recircTable(state: StateSnapshot): string {
  const rc = state.recirc as {
    active?: boolean; branches?: { returnPipeId: string; loopLengthM: number; flowLps: number; frictionM: number; isIndex: boolean; balanceHeadM: number; balanceValveKv: number | null }[];
    loopLengthM?: number; recircFlowLps?: number; frictionM?: number; pumpHeadKPa?: number;
  } | null;
  if (!rc?.active) return '';

  const note = `<p class="meta">Hot-water recirculation detected — ${esc((rc.branches ?? []).length)} branch(es), governing loop ${esc(rc.loopLengthM)} m. Total design recirculation flow <b>${esc(rc.recircFlowLps)} L/s</b>, split by loop length. Governing loop friction <b>${esc(rc.frictionM)} m</b>, giving a pump head of <b>${esc(rc.pumpHeadKPa)} kPa</b>. Balancing valve head = index-loop friction − branch friction (proportional balancing, first pass).</p>`;
  const rows = [...(rc.branches ?? [])]
    .sort((a, b) => b.frictionM - a.frictionM)
    .map((b) => `<tr><td>${esc(b.returnPipeId)}</td><td class="num">${esc(b.loopLengthM)}</td><td class="num">${esc(b.flowLps)}</td><td class="num">${esc(b.frictionM)}</td><td>${b.isIndex ? '<b>index (open)</b>' : 'balance'}</td><td class="num">${b.isIndex ? '—' : esc(b.balanceHeadM)}</td><td class="num">${dash(b.balanceValveKv)}</td></tr>`)
    .join('');
  return note + table([{ h: 'Return' }, { h: 'Loop (m)', n: true }, { h: 'Flow (L/s)', n: true }, { h: 'Friction (m)', n: true }, { h: 'Valve' }, { h: 'Balance head (m)', n: true }, { h: 'Kv (m³/h)', n: true }], rows);
}

function dwvTable(state: StateSnapshot): string {
  const dw = state.dwv as {
    active?: boolean; totalDfu?: number; allDrained?: boolean; hasVentSystem?: boolean; allVented?: boolean;
    fixtures?: { id: string; type: string; dfu: number; drained: boolean; vented: boolean }[];
  } | null;
  if (!dw?.active) return '';

  const tick = (ok: boolean): string => (ok ? '<span class="ok">✓</span>' : '<b class="bad">✗</b>');
  const summary = `<p class="meta">Total drainage load reaching the outlet: <b>${esc(dw.totalDfu)} DFU</b>. Every fixture drained: <b>${dw.allDrained ? 'yes' : 'no'}</b>; venting present: <b>${dw.hasVentSystem ? 'yes' : 'no'}</b>; every trap vented: <b>${dw.allVented ? 'yes' : 'no'}</b>. Connectivity is established by graph reachability (drainage → outlet, vent → roof terminal).</p>`;
  const rows = (dw.fixtures ?? []).map((f) => `<tr><td>${esc(f.id)}</td><td>${esc(humanise(f.type))}</td><td class="num">${esc(f.dfu)}</td><td>${tick(f.drained)}</td><td>${tick(f.vented)}</td></tr>`).join('');
  return summary + table([{ h: 'Tag' }, { h: 'Fixture' }, { h: 'DFU', n: true }, { h: 'Drained' }, { h: 'Vented' }], rows);
}

function drainTable(pipes: PipeDto[]): string {
  if (pipes.length === 0) return '';
  const kind = (p: PipeDto): string => (p.isOffset ? 'offset' : p.isStack ? `stack ×${p.stackFloors}` : 'branch/drain');
  return table(
    [{ h: 'Tag' }, { h: 'Type' }, { h: 'Ø (mm)', n: true }, { h: 'DFU', n: true }, { h: 'Interval DFU', n: true }, { h: 'Slope (%)', n: true }, { h: 'Velocity (m/s)', n: true }, { h: 'Length (m)', n: true }, { h: 'Status' }],
    pipes.map((p) => `<tr><td>${esc(p.id)}</td><td>${esc(kind(p))}</td><td class="num">${dash(p.sizeOd)}</td><td class="num">${dash(p.cumulativeDfu)}</td><td class="num">${p.isStack ? dash(p.perIntervalDfu) : '—'}</td><td class="num">${p.isStack ? '—' : dash(p.slopePct)}</td><td class="num">${p.isStack ? '—' : dash(p.velocityMs)}</td><td class="num">${esc(p.lengthM)}</td><td>${status(pipeOk(p) && p.branchPass !== false && !p.isOffset)}</td></tr>`).join(''),
  );
}

function ventTable(pipes: PipeDto[]): string {
  if (pipes.length === 0) return '';
  return table(
    [{ h: 'Tag' }, { h: 'Ø (mm)', n: true }, { h: 'DFU protected', n: true }, { h: 'Length (m)', n: true }],
    pipes.map((p) => `<tr><td>${esc(p.id)}</td><td class="num">${dash(p.sizeOd)}</td><td class="num">${dash(p.cumulativeDfu)}</td><td class="num">${esc(p.lengthM)}</td></tr>`).join(''),
  );
}

function powerTable(pipes: PipeDto[]): string {
  if (pipes.length === 0) return '';
  return table(
    [{ h: 'Tag' }, { h: 'CSA (mm²)', n: true }, { h: 'Design current (A)', n: true }, { h: 'Volt drop (%)', n: true }, { h: 'Length (m)', n: true }, { h: 'Status' }],
    pipes.map((p) => `<tr><td>${esc(p.id)}</td><td class="num">${dash(p.sizeOd)}</td><td class="num">${dash(p.cumulativeAmps)}</td><td class="num">${dash(p.vdPct)}</td><td class="num">${esc(p.lengthM)}</td><td>${status(p.sizePass !== false && p.velocityPass !== false)}</td></tr>`).join(''),
  );
}

function airTable(pipes: PipeDto[]): string {
  if (pipes.length === 0) return '';
  return table(
    [{ h: 'Tag' }, { h: 'Ø (mm)', n: true }, { h: 'Airflow (L/s)', n: true }, { h: 'Velocity (m/s)', n: true }, { h: 'Length (m)', n: true }, { h: 'Status' }],
    pipes.map((p) => `<tr><td>${esc(p.id)}</td><td class="num">${dash(p.sizeOd)}</td><td class="num">${dash(p.cumulativeAirLps)}</td><td class="num">${dash(p.velocityMs)}</td><td class="num">${esc(p.lengthM)}</td><td>${status(pipeOk(p))}</td></tr>`).join(''),
  );
}

function beamTable(pipes: PipeDto[]): string {
  if (pipes.length === 0) return '';
  return table(
    [{ h: 'Tag' }, { h: 'Span (m)', n: true }, { h: 'Depth (mm)', n: true }, { h: 'Load (kN/m)', n: true }, { h: 'Reinforcement' }],
    pipes.map((p) => `<tr><td>${esc(p.id)}</td><td class="num">${esc(p.lengthM)}</td><td class="num">${dash(p.sizeOd)}</td><td class="num">${dash(p.beamLoad)}</td><td>${dash(p.reinf)}</td></tr>`).join(''),
  );
}

function columnTable(nodes: NodeDto[]): string {
  if (nodes.length === 0) return '';
  return table(
    [{ h: 'Tag' }, { h: 'Section (mm)' }, { h: 'Floors', n: true }, { h: 'Total Pu (kN)', n: true }, { h: 'Capacity' }, { h: 'Utilisation' }, { h: 'Reinforcement' }, { h: 'Status' }],
    nodes.map((n) => {
      const col = n.column!;
      const size = col.size === null || col.size === undefined ? '—' : `${esc(col.size)}×${esc(col.size)}`;
      return `<tr><td>${esc(n.id)}</td><td>${size}</td><td class="num">${dash(n.floorsSupported)}</td><td class="num">${dash(n.axialLoadKn)}</td><td>${dash(col.capacity)}</td><td>${dash(col.utilization)}</td><td>${dash(col.reinforcement)}</td><td>${status(col.pass !== false)}</td></tr>`;
    }).join(''),
  );
}

function slabTable(slabs: SlabDto[]): string {
  if (slabs.length === 0) return '';
  return table(
    [{ h: 'Tag' }, { h: 'Area (m²)', n: true }, { h: 'Spans S/L (m)' }, { h: 'Type' }, { h: 'Thickness (mm)', n: true }, { h: 'Steel' }, { h: 'Status' }],
    slabs.map((sl) => `<tr><td>${esc(sl.id)}</td><td class="num">${dash(sl.areaM2)}</td><td>${dash(sl.shortSpan)} / ${dash(sl.longSpan)}</td><td>${dash(sl.type)}</td><td class="num">${dash(sl.thickness)}</td><td>${dash(sl.steel)}</td><td>${status(sl.pass !== false)}</td></tr>`).join(''),
  );
}

function fittingTable(nodes: NodeDto[]): string {
  if (nodes.length === 0) return '';
  return table(
    [{ h: 'Tag' }, { h: 'Type' }, { h: 'Ø (mm)' }],
    nodes.map((n) => {
      const [type, od] = String(n.fixtureType ?? '').split('|');
      return `<tr><td>${esc(n.id)}</td><td>${esc(humanise(type))}</td><td>${od ? `Ø${esc(od)}` : '—'}</td></tr>`;
    }).join(''),
  );
}

function fixtureTable(nodes: NodeDto[]): string {
  const counts = new Map<string, number>();
  for (const n of nodes) {
    const key = String(n.fixtureType ?? 'Unknown');
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  if (counts.size === 0) return '';
  return table(
    [{ h: 'Fixture' }, { h: 'Qty', n: true }],
    [...counts.keys()].sort().map((t) => `<tr><td>${esc(humanise(t))}</td><td class="num">${esc(counts.get(t))}</td></tr>`).join(''),
  );
}

/* ------------------------------------------------------------------ cost */

function groupBoq(boq: BoqDto[]): Map<string, BoqDto[]> {
  const groups = new Map<string, BoqDto[]>();
  for (const line of boq) {
    const key = line.group || 'Other';
    const list = groups.get(key);
    if (list === undefined) groups.set(key, [line]);
    else list.push(line);
  }
  return new Map([...groups.entries()].sort((a, b) => a[0].localeCompare(b[0])));
}

const subtotal = (lines: BoqDto[]): number => round(lines.reduce((sum, l) => sum + (l.lineCost || 0), 0), 2);

function costSummary(state: StateSnapshot): string {
  const groups = groupBoq(state.boq);
  const rows = [...groups].map(([name, lines]) => `<tr><td>${esc(name)}</td><td class="num">${esc(subtotal(lines))}</td></tr>`).join('');
  return table([{ h: 'Discipline' }, { h: 'Amount', n: true }], `${rows}<tr class="sub"><td>Project total</td><td class="num"><b>${esc(state.costTotal ?? 0)}</b></td></tr>`);
}

function boqTable(state: StateSnapshot): string {
  const groups = groupBoq(state.boq);
  const rows = [...groups].map(([name, lines]) =>
    `<tr class="grp"><td colspan="5">${esc(name)}</td></tr>`
    + lines.map((l) => `<tr><td>${esc(l.itemCode)}</td><td>${esc(l.description)}</td><td class="num">${esc(l.qty)}</td><td>${esc(l.unit)}</td><td class="num">${l.lineCost === null || l.lineCost === undefined ? '' : esc(l.lineCost)}</td></tr>`).join('')
    + `<tr class="sub"><td colspan="4">subtotal</td><td class="num">${esc(subtotal(lines))}</td></tr>`,
  ).join('');
  return table(
    [{ h: 'Code' }, { h: 'Description' }, { h: 'Qty', n: true }, { h: 'Unit' }, { h: 'Amount', n: true }],
    `${rows}<tr class="total"><td colspan="4"><b>Project total</b></td><td class="num"><b>${esc(state.costTotal ?? 0)}</b></td></tr>`,
  );
}
