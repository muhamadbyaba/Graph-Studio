import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CATALOG, disciplines, filterCatalog, slug } from '../src/catalog/catalog.ts';

test('the catalog spans multiple disciplines, not just plumbing', () => {
  const d = disciplines(DEFAULT_CATALOG);
  for (const need of ['plumbing', 'electrical', 'hvac', 'finishes']) assert.ok(d.includes(need), `missing ${need}`);
});

test('it contains real PPR pipes, fittings, and drainage', () => {
  assert.ok(DEFAULT_CATALOG.some((i) => i.category === 'pipe' && String(i.name).includes('PPR PN20 Ø25')));
  assert.ok(DEFAULT_CATALOG.some((i) => i.category === 'fitting' && String(i.name).includes('Transition Male')));
  assert.ok(DEFAULT_CATALOG.some((i) => i.category === 'drain-pipe' && String(i.name).includes('Ø110')));
});

test('filter by discipline + query works', () => {
  const cables = filterCatalog(DEFAULT_CATALOG, { discipline: 'electrical', query: 'cable' });
  assert.ok(cables.length >= 5);
  assert.ok(cables.every((i) => i.discipline === 'electrical'));
});

test('every item has a stable, unique id', () => {
  const ids = DEFAULT_CATALOG.map((i) => i.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(slug('PPR Elbow 90° Ø25mm'), 'ppr-elbow-90-25mm'); // non-alphanumerics collapse to a single dash
});
