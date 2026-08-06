import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PlumbingLayout } from '../src/model/layout.ts';
import { sizeBeamRule } from '../src/structural/beams.ts';
import { RuleRegistry } from '../src/rules/registry.ts';
import { GULF_V1 } from '../src/jurisdiction/gulf.ts';

test('RC beam sizing: Mu = wL²/8, depth ≥ span/16, with a reinforcement estimate', () => {
  const reg = new RuleRegistry(GULF_V1).register(sizeBeamRule);
  // 6 m span, 20 kN/m → Mu = 90 kN·m; min depth 375 mm → Ø400 mm section
  const res = reg.evaluate('structural.beam.size', { spanM: 6, loadKnPerM: 20 });
  assert.equal(res.value, 400);
  assert.equal(res.pass, true);
  assert.match(res.trace.inputs.Mu, /90/);
  assert.match(res.trace.inputs.reinforcement, /mm²/);
});

test('a longer / heavier beam needs a deeper section', () => {
  const reg = new RuleRegistry(GULF_V1).register(sizeBeamRule);
  const short = reg.evaluate('structural.beam.size', { spanM: 6, loadKnPerM: 20 }).value as number;
  const long = reg.evaluate('structural.beam.size', { spanM: 10, loadKnPerM: 40 }).value as number;
  assert.ok(long > short);
});

/** support(0,0) — beam — support(6,0) */
test('a beam member is sized from its span (geometry) and load, and lands in the BOQ', () => {
  const net = new PlumbingLayout(GULF_V1)
    .addNode('s1', 'support', 0, 0)
    .addNode('s2', 'support', 6, 0)
    .addPipe('B1', 's1', 's2', 'beam');
  const beam = net.pipes.get('B1')!;
  assert.equal(beam.lengthM.get(), 6); // span from geometry
  assert.equal(beam.sizing.get().value, 400); // default 15 kN/m over 6 m
  net.setBeamLoad('B1', 40); // heavier → deeper
  assert.ok((beam.sizing.get().value as number) >= 400);
  assert.ok(net.boq.get().some((l) => l.itemCode.startsWith('BEAM-') && l.group === 'Structural'));
});
