/**
 * End-to-end demo: a villa bathroom cold-water branch, from fixtures → demand → pipe size →
 * validation, printing the full trace for every number. This is the "explainable engineering"
 * requirement made concrete (Doc 06 §4, plumbing spec §3.13).
 *
 * Run:  node examples/villa-branch.ts
 */
import { RuleRegistry } from '../src/rules/registry.ts';
import { GULF_V1 } from '../src/jurisdiction/gulf.ts';
import { sumWsfu, hunterDemand } from '../src/plumbing/demand.ts';
import { sizeSupplyPipeRule } from '../src/plumbing/sizing.ts';
import { velocityCheckRule, headlossRule } from '../src/plumbing/rules.ts';
import { pprInnerDiameter } from '../src/plumbing/hydraulics.ts';
import { qty, mm, lps, meter } from '../src/units/index.ts';
import type { RuleResult } from '../src/rules/rule.ts';

const reg = new RuleRegistry(GULF_V1)
  .register(sizeSupplyPipeRule)
  .register(velocityCheckRule)
  .register(headlossRule);

function showTrace(title: string, res: RuleResult): void {
  console.log(`\n### ${title}`);
  console.log(`value: ${String(res.value)}   pass: ${res.pass ?? '—'}   severity: ${res.severity ?? '—'}`);
  console.log(`formula: ${res.trace.formula}`);
  console.log(`inputs:  ${JSON.stringify(res.trace.inputs)}`);
  for (const s of res.trace.steps) console.log(`  • ${s.expr}  →  ${s.result}`);
  console.log(`clause:  ${res.trace.clause}`);
  console.log(`assumptions: ${res.trace.assumptions.join('; ')}`);
}

// 1) Fixtures on the branch → cumulative WSFU
const fixtures = [
  { type: 'WaterCloset', count: 1 },
  { type: 'Lavatory', count: 1 },
  { type: 'Shower', count: 1 },
];
const wsfu = sumWsfu(fixtures, GULF_V1);

// 2) Probable simultaneous demand (Hunter)
const demand = hunterDemand(wsfu, GULF_V1);

console.log('=== Villa bathroom cold-water branch (jurisdiction: GULF@' + GULF_V1.version + ') ===');
console.log(`fixtures: ${fixtures.map((f) => `${f.count}×${f.type}`).join(', ')}`);
console.log(`cumulative WSFU: ${wsfu}`);
console.log(`probable demand: ${demand.in(lps).toFixed(3)} L/s  (Hunter table, diversity applied)`);

// 3) Size the pipe
const size = reg.evaluate('plumbing.supply.sizePipe', { flow: demand, medium: 'cold' });
showTrace('Pipe sizing', size);

// 4) Validate the chosen size, and compute head loss over a 6 m run
const chosenOd = size.value as number;
const chosenSdr = GULF_V1.supply.pprCatalog.find((p) => p.odMm === chosenOd)!.sdr;
const id = pprInnerDiameter(qty(chosenOd, mm), chosenSdr);

showTrace(
  'Velocity check',
  reg.evaluate('plumbing.supply.velocity', { flow: demand, innerDiameter: id, medium: 'cold' }),
);
showTrace(
  'Head loss (6 m run)',
  reg.evaluate('plumbing.supply.headloss', { flow: demand, innerDiameter: id, length: qty(6, meter) }),
);

console.log('\n(every number above is produced by a deterministic rule and carries its trace)');
