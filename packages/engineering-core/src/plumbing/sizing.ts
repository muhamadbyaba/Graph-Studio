import { qty, mm, mps, lps } from '../units/index.ts';
import { velocity, pprInnerDiameter } from './hydraulics.ts';
import type { Quantity } from '../units/quantity.ts';
import type { Rule, TraceStep } from '../rules/rule.ts';
import type { PprSize } from '../jurisdiction/types.ts';

/**
 * plumbing.supply.sizePipe — pick the smallest PPR size whose full-bore velocity stays within the
 * jurisdiction limit for the medium. Emits a trace showing every candidate considered (Doc 03 §3.2,
 * plumbing spec §3.2). The catalog + limits are jurisdiction data, so this logic is discipline-,
 * not code-, specific.
 */

export interface SizeSupplyPipeInput {
  readonly flow: Quantity;
  readonly medium: 'cold' | 'hot';
}

const SIZE_ASSUMPTIONS = [
  'Steady peak demand',
  'PPR catalog and velocity limits per the pinned jurisdiction pack',
  'Selection governed by velocity (head-loss/pressure checked separately)',
];

export const sizeSupplyPipeRule: Rule<SizeSupplyPipeInput> = {
  id: 'plumbing.supply.sizePipe',
  discipline: 'plumbing',
  standardRef: 'Velocity-method pipe selection; limits per jurisdiction pack — VERIFY',
  assumptions: SIZE_ASSUMPTIONS,

  evaluate(input, ctx) {
    const limit =
      input.medium === 'cold'
        ? ctx.jurisdiction.supply.velocityLimitColdMps
        : ctx.jurisdiction.supply.velocityLimitHotMps;

    const steps: TraceStep[] = [];
    let chosen: PprSize | null = null;

    for (const size of ctx.jurisdiction.supply.pprCatalog) {
      const id = pprInnerDiameter(qty(size.odMm, mm), size.sdr);
      const v = velocity(input.flow, id).in(mps);
      const ok = v <= limit;
      steps.push({
        expr: `OD${size.odMm} PN${size.pn} (id=${id.in(mm).toFixed(1)} mm): v = 4Q/(π·d²)`,
        result: `${v.toFixed(3)} m/s ${ok ? '≤' : '>'} ${limit} m/s`,
      });
      if (ok) {
        chosen = size;
        break;
      }
    }

    return {
      value: chosen ? chosen.odMm : null,
      pass: chosen !== null,
      severity: chosen ? undefined : 'violation',
      trace: {
        formula: 'smallest OD where v = 4Q/(π·d²) ≤ velocity limit',
        inputs: {
          flow: `${input.flow.in(lps).toFixed(3)} L/s`,
          medium: input.medium,
          velocityLimit: `${limit} m/s`,
        },
        steps,
        clause: ctx.jurisdiction.standardRef,
        assumptions: SIZE_ASSUMPTIONS,
      },
    };
  },
};
