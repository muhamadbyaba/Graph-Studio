import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PlumbingLayout } from '../src/model/layout.ts';
import { GULF_V1 } from '../src/jurisdiction/gulf.ts';
import { US_V1 } from '../src/jurisdiction/us.ts';
import { JURISDICTIONS } from '../src/jurisdiction/registry.ts';

test('the same circuit re-sizes cables under US (120 V) vs Gulf (230 V)', () => {
  const cable = (pack: typeof GULF_V1) =>
    new PlumbingLayout(pack)
      .addNode('db', 'panel', 0, 0)
      .addNode('l', 'load', 30, 0)
      .addPipe('c', 'db', 'l', 'power')
      .pipes.get('c')!.sizing.get().value as number;
  const gulf = cable(GULF_V1); // 230 V → smaller cable OK on voltage drop
  const us = cable(US_V1); // 120 V → higher Vd% → must upsize
  assert.ok(us > gulf, `expected US cable (${us}) larger than Gulf (${gulf})`);
});

test('the same supply pipe can pass one jurisdiction and be tighter in another (velocity limit differs)', () => {
  // Gulf cold limit 2.0 m/s, US 2.4 m/s → US is more permissive on velocity.
  assert.ok(US_V1.supply.velocityLimitColdMps > GULF_V1.supply.velocityLimitColdMps);
});

test('a beam re-sizes reinforcement under a different concrete strength / cover', () => {
  const beam = (pack: typeof GULF_V1) => {
    const net = new PlumbingLayout(pack).addNode('a', 'support', 0, 0).addNode('b', 'support', 6, 0).addPipe('B', 'a', 'b', 'beam');
    net.setBeamLoad('B', 30);
    return net.pipes.get('B')!.sizing.get().trace.inputs.reinforcement;
  };
  // Different cover (50 vs 40 mm) → different effective depth → different As estimate
  assert.notEqual(beam(GULF_V1), beam(US_V1));
});

test('the registry exposes both packs', () => {
  assert.ok(JURISDICTIONS.GULF);
  assert.ok(JURISDICTIONS.US);
  assert.equal(JURISDICTIONS.US.electrical!.nominalVoltageV, 120);
});
