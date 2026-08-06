/**
 * Component / product library (Doc 01 §4 smart objects, Doc 08 reuse-across-disciplines). A
 * discipline-agnostic catalog of real construction components — pipes, fittings, valves, fixtures,
 * cables, breakers, ducts, tiles, paint … Each item carries a spec, unit, and optional price. The
 * app lets users browse it and add their own items (persisted server-side), and the same shape
 * serves every discipline — plumbing is just the first section populated.
 */

export interface CatalogItem {
  readonly id: string;
  readonly discipline: string; // 'plumbing' | 'electrical' | 'hvac' | 'finishes' | …
  readonly category: string; // 'pipe' | 'fitting' | 'valve' | 'fixture' | 'cable' | 'tile' | …
  readonly name: string;
  readonly spec: Readonly<Record<string, string | number>>;
  readonly unit: string; // 'm' | 'nr' | 'm²' | 'L'
  readonly price?: number;
  readonly manufacturer?: string;
  readonly custom?: boolean; // user-added
}

export function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

function mk(discipline: string, category: string, name: string, spec: Record<string, string | number>, unit: string, price?: number): CatalogItem {
  return { id: slug(`${discipline}-${category}-${name}`), discipline, category, name, spec, unit, price };
}

function buildDefault(): CatalogItem[] {
  const items: CatalogItem[] = [];

  // ---- Plumbing: PPR supply ----
  for (const od of [20, 25, 32, 40, 50, 63, 75, 90, 110]) {
    items.push(mk('plumbing', 'pipe', `PPR PN20 Ø${od}mm`, { odMm: od, pn: 20, material: 'PPR-R' }, 'm'));
  }
  const pprFittings = ['Elbow 90°', 'Elbow 45°', 'Tee', 'Cross', 'Coupling', 'Reducer', 'Union', 'End Cap', 'Transition Male (Brass)', 'Transition Female (Brass)'];
  for (const od of [20, 25, 32, 40, 50]) {
    for (const t of pprFittings) {
      const brass = t.includes('Brass');
      items.push(mk('plumbing', 'fitting', `PPR ${t} Ø${od}mm`, { odMm: od, type: t, material: brass ? 'PPR + Brass insert' : 'PPR-R', joint: 'socket fusion' }, 'nr'));
    }
  }
  for (const od of [20, 25, 32]) {
    for (const v of ['Gate Valve', 'Ball Valve', 'Check Valve', 'PRV']) items.push(mk('plumbing', 'valve', `${v} Ø${od}mm`, { odMm: od, type: v }, 'nr'));
  }
  // Plumbing: drainage uPVC
  for (const od of [40, 50, 75, 110, 160]) items.push(mk('plumbing', 'drain-pipe', `uPVC drain Ø${od}mm`, { odMm: od, material: 'uPVC' }, 'm'));
  for (const t of ['Bend 90°', 'Bend 45°', 'Tee', 'Wye', 'Coupling', 'Cleanout', 'P-Trap', 'Floor Trap']) items.push(mk('plumbing', 'drain-fitting', `uPVC ${t}`, { type: t, material: 'uPVC' }, 'nr'));
  // Plumbing: fixtures + equipment
  for (const f of ['Water Closet', 'Lavatory', 'Shower', 'Bathtub', 'Kitchen Sink', 'Washing Machine Outlet', 'Hose Bibb', 'Urinal', 'Floor Drain']) items.push(mk('plumbing', 'fixture', f, { type: f }, 'nr'));
  items.push(mk('plumbing', 'equipment', 'GRP Water Tank 1000 L', { capacityL: 1000, material: 'GRP' }, 'nr'));
  items.push(mk('plumbing', 'equipment', 'Booster Pump 1.1 kW', { powerKw: 1.1 }, 'nr'));
  items.push(mk('plumbing', 'equipment', 'Electric Water Heater 50 L', { storageL: 50, powerKw: 2 }, 'nr'));

  // ---- Electrical ----
  for (const csa of [1.5, 2.5, 4, 6, 10, 16, 25]) items.push(mk('electrical', 'cable', `Cu cable ${csa} mm²`, { csaMm2: csa, conductor: 'copper' }, 'm'));
  for (const a of [6, 10, 16, 20, 32, 40]) items.push(mk('electrical', 'protection', `MCB ${a} A`, { ratingA: a, poles: 1 }, 'nr'));
  for (const c of ['13A Socket', '2-Gang Switch', 'Distribution Board 12-way', 'LED Downlight 18 W', 'LED Panel 36 W', 'Conduit Ø20mm', 'Conduit Ø25mm']) items.push(mk('electrical', 'accessory', c, { type: c }, c.startsWith('Conduit') ? 'm' : 'nr'));

  // ---- HVAC ----
  for (const s of ['150×150', '200×200', '300×300', '400×300']) items.push(mk('hvac', 'duct', `GI duct ${s} mm`, { size: s, material: 'galvanised steel' }, 'm'));
  for (const c of ['Supply Diffuser', 'Return Grille', 'VAV Box', 'Split AC 1.5 Ton', 'Split AC 2 Ton', 'Exhaust Fan']) items.push(mk('hvac', 'equipment', c, { type: c }, 'nr'));

  // ---- Finishes ----
  for (const t of ['Ceramic 300×300', 'Porcelain 600×600', 'Marble slab', 'Limestone tile']) items.push(mk('finishes', 'tile', t, { type: t }, 'm²'));
  items.push(mk('finishes', 'paint', 'Emulsion paint', { coats: 2, spreadingM2PerL: 10 }, 'L'));
  items.push(mk('finishes', 'board', 'Gypsum board 12.5 mm', { thicknessMm: 12.5 }, 'm²'));

  return items;
}

/** The built-in library. Users' additions live server-side and are merged on top of this. */
export const DEFAULT_CATALOG: readonly CatalogItem[] = buildDefault();

export function disciplines(items: readonly CatalogItem[]): string[] {
  return [...new Set(items.map((i) => i.discipline))].sort();
}

export function filterCatalog(items: readonly CatalogItem[], opts: { discipline?: string; query?: string }): CatalogItem[] {
  const q = opts.query?.trim().toLowerCase();
  return items.filter((i) => {
    if (opts.discipline && i.discipline !== opts.discipline) return false;
    if (q && !(`${i.name} ${i.category} ${JSON.stringify(i.spec)}`.toLowerCase().includes(q))) return false;
    return true;
  });
}
