import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PlumbingLayout } from '../src/model/layout.ts';
import { sizeDuctOd } from '../src/hvac/ducts.ts';
import { GULF_V1 } from '../src/jurisdiction/gulf.ts';
import { qty, lps } from '../src/units/index.ts';
import { approx } from './helpers.ts';

test('duct sizing picks the smallest round duct within the velocity limit', () => {
  // 50 L/s: Ø100 → 6.4 m/s (> 5, fail), Ø125 → 4.1 m/s (ok)
  assert.equal(sizeDuctOd(qty(50, lps), GULF_V1), 125);
  // 150 L/s → Ø200
  assert.equal(sizeDuctOd(qty(150, lps), GULF_V1), 200);
});

/** ahu(0,0) — duct — junction(5,0) — {diffuser(5,3), diffuser(30,0)} */
function airSystem(): PlumbingLayout {
  return new PlumbingLayout(GULF_V1)
    .addNode('ahu', 'ahu', 0, 0)
    .addNode('j', 'junction', 5, 0)
    .addNode('d1', 'diffuser', 5, 3)
    .addNode('d2', 'diffuser', 30, 0)
    .addPipe('main', 'ahu', 'j', 'air')
    .addPipe('b1', 'j', 'd1', 'air')
    .addPipe('b2', 'j', 'd2', 'air');
}

test('duct carries cumulative airflow of its downstream diffusers', () => {
  const net = airSystem();
  approx(net.pipes.get('main')!.cumulativeAirLps.get(), 100, 1e-9); // two 50 L/s diffusers
  approx(net.pipes.get('b1')!.cumulativeAirLps.get(), 50, 1e-9);
});

test('the main duct is sized from cumulative airflow', () => {
  const net = airSystem();
  const main = net.pipes.get('main')!;
  assert.equal(main.sizing.get().value, 160); // 100 L/s → Ø160 (4.98 m/s ≤ 5)
  assert.equal(main.velocity.get().pass, true);
});

test('increasing a diffuser airflow upsizes the upstream duct', () => {
  const net = airSystem();
  const before = net.pipes.get('main')!.sizing.get().value as number;
  net.setAirflow('d1', 200); // 250 L/s total on the main
  assert.ok((net.pipes.get('main')!.sizing.get().value as number) > before);
});

test('BOQ lists ducts by size and diffusers; independent from plumbing/electrical', () => {
  const net = airSystem();
  const codes = net.boq.get().map((l) => l.itemCode);
  assert.ok(codes.some((c) => c.startsWith('DUCT-')));
  assert.ok(codes.includes('HVAC-diffuser'));
});
