import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultRate } from '../src/boq/costbook.ts';
import { PlumbingLayout } from '../src/model/layout.ts';
import { GULF_V1 } from '../src/jurisdiction/gulf.ts';

test('defaultRate returns size-based unit rates', () => {
  assert.equal(defaultRate('PPR-OD25-PN20-cold'), 3.2);
  assert.equal(defaultRate('DRAIN-OD110'), 11);
  assert.equal(defaultRate('CABLE-4'), 2.8);
  assert.equal(defaultRate('CABLE-1.5'), 1.2);
  assert.equal(defaultRate('FIX-WaterCloset'), 60);
  assert.equal(defaultRate('ELEC-load'), 15);
  assert.equal(defaultRate('PROD-anything'), 0); // product lines carry their own price
});

test('BOQ lines carry a rate; a chosen product price overrides the rate book', () => {
  const net = new PlumbingLayout(GULF_V1)
    .addNode('t', 'source', 0, 0)
    .addNode('wc', 'fixture', 3, 0, 'WaterCloset')
    .addPipe('p', 't', 'wc', 'cold');
  const pipeLine = net.boq.get().find((l) => l.itemCode.startsWith('PPR-OD'))!;
  assert.ok((pipeLine.rate ?? 0) > 0);
  const wcLine = net.boq.get().find((l) => l.itemCode === 'FIX-WaterCloset')!;
  assert.equal(wcLine.rate, 60);

  net.setPipeProduct('p', { name: 'Premium PPR Ø25', material: 'PPR-R', odMm: 25, price: 9.9 });
  const prodLine = net.boq.get().find((l) => l.itemCode.startsWith('PROD-'))!;
  assert.equal(prodLine.rate, 9.9);
});

test('every BOQ line is tagged with a discipline group', () => {
  const net = new PlumbingLayout(GULF_V1)
    .addNode('t', 'source', 0, 0).addNode('wc', 'fixture', 3, 0, 'WaterCloset').addPipe('p', 't', 'wc', 'cold')
    .addNode('db', 'panel', 0, 6).addNode('l', 'load', 3, 6).addPipe('c', 'db', 'l', 'power');
  const groups = new Set(net.boq.get().map((l) => l.group));
  assert.ok(groups.has('Plumbing — supply'));
  assert.ok(groups.has('Plumbing — fixtures'));
  assert.ok(groups.has('Electrical'));
});
