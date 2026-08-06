import { mm, mps, lps, meter } from '../units/index.ts';
import { velocity, hazenWilliamsHeadloss } from './hydraulics.ts';
import type { Quantity } from '../units/quantity.ts';
import type { Rule } from '../rules/rule.ts';

/** Validation + calculation rules for supply piping (Doc 03 §2, plumbing spec §3, §5). */

export interface VelocityCheckInput {
  readonly flow: Quantity;
  readonly innerDiameter: Quantity;
  readonly medium: 'cold' | 'hot';
}

const VELOCITY_ASSUMPTIONS = ['Steady flow', 'Full-bore circular pipe'];

export const velocityCheckRule: Rule<VelocityCheckInput> = {
  id: 'plumbing.supply.velocity',
  discipline: 'plumbing',
  standardRef: 'Supply velocity limit — jurisdiction pack — VERIFY',
  assumptions: VELOCITY_ASSUMPTIONS,

  evaluate(input, ctx) {
    const limit =
      input.medium === 'cold'
        ? ctx.jurisdiction.supply.velocityLimitColdMps
        : ctx.jurisdiction.supply.velocityLimitHotMps;
    const v = velocity(input.flow, input.innerDiameter);
    const vv = v.in(mps);
    const pass = vv <= limit;
    return {
      value: v,
      pass,
      severity: pass ? undefined : 'violation',
      trace: {
        formula: 'v = 4Q/(π·d²) ; require v ≤ limit',
        inputs: {
          flow: `${input.flow.in(lps).toFixed(3)} L/s`,
          innerDiameter: `${input.innerDiameter.in(mm).toFixed(1)} mm`,
          limit: `${limit} m/s`,
        },
        steps: [{ expr: '4Q/(π·d²)', result: `${vv.toFixed(3)} m/s ${pass ? '≤' : '>'} ${limit} m/s` }],
        clause: ctx.jurisdiction.standardRef,
        assumptions: VELOCITY_ASSUMPTIONS,
      },
    };
  },
};

export interface HeadlossInput {
  readonly flow: Quantity;
  readonly innerDiameter: Quantity;
  readonly length: Quantity;
}

const HEADLOSS_ASSUMPTIONS = ['C per jurisdiction pack (PPR)', 'Excludes minor/fitting losses'];

export const headlossRule: Rule<HeadlossInput> = {
  id: 'plumbing.supply.headloss',
  discipline: 'plumbing',
  standardRef: 'Hazen–Williams (SI)',
  assumptions: HEADLOSS_ASSUMPTIONS,

  evaluate(input, ctx) {
    const C = ctx.jurisdiction.supply.hazenWilliamsC_PPR;
    const hf = hazenWilliamsHeadloss(input.flow, input.innerDiameter, C, input.length);
    return {
      value: hf,
      trace: {
        formula: 'hf = 10.67·L·Q^1.852 / (C^1.852·d^4.87)',
        inputs: {
          flow: `${input.flow.in(lps).toFixed(3)} L/s`,
          innerDiameter: `${input.innerDiameter.in(mm).toFixed(1)} mm`,
          length: `${input.length.in(meter).toFixed(2)} m`,
          C: String(C),
        },
        steps: [{ expr: 'Hazen–Williams (SI)', result: `${hf.in(meter).toFixed(3)} m` }],
        clause: 'Hazen–Williams empirical head loss (SI form)',
        assumptions: HEADLOSS_ASSUMPTIONS,
      },
    };
  },
};
