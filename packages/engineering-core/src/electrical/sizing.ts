import { ampere, meter, volt } from '../units/index.ts';
import { voltageDrop } from './electrics.ts';
import type { Phase } from './electrics.ts';
import type { Quantity } from '../units/quantity.ts';
import type { Rule, TraceStep } from '../rules/rule.ts';
import type { CableSize } from '../jurisdiction/types.ts';

/**
 * electrical.power.sizeCable — pick the smallest conductor that satisfies BOTH ampacity
 * (Ib ≤ Iz) AND voltage drop (Vd% ≤ limit). Structurally identical to the plumbing pipe-sizing
 * rule: same Rule contract, same trace shape, a catalog walked ascending, two coupled checks.
 * The blueprint (Doc 08 §6) in action.
 */

export interface SizeCableInput {
  readonly designCurrent: Quantity;
  readonly lengthOneWay: Quantity;
  readonly phase?: Phase;
}

const SIZE_ASSUMPTIONS = [
  'Copper conductors per the pinned jurisdiction pack',
  'Ampacity already includes the pack derating factor',
  'Voltage drop referenced to nominal voltage; final-branch limit',
];

export const sizeCableRule: Rule<SizeCableInput> = {
  id: 'electrical.power.sizeCable',
  discipline: 'electrical',
  standardRef: 'Ampacity (Ib ≤ Iz) + voltage-drop selection; limits per jurisdiction pack — VERIFY',
  assumptions: SIZE_ASSUMPTIONS,

  evaluate(input, ctx) {
    const el = ctx.jurisdiction.electrical;
    if (!el) throw new Error(`Jurisdiction ${ctx.jurisdiction.id} has no electrical data`);

    const phase = input.phase ?? 'single';
    const Ib = input.designCurrent.in(ampere);
    const steps: TraceStep[] = [];
    let chosen: CableSize | null = null;

    for (const cable of el.cableCatalog) {
      const Iz = cable.ampacityA * el.deratingFactor;
      const ampOk = Ib <= Iz;
      let vdPct = Number.NaN;
      let vdOk = false;
      if (ampOk) {
        const vd = voltageDrop(input.designCurrent, input.lengthOneWay, cable.resistanceOhmPerM, phase).in(volt);
        vdPct = (vd / el.nominalVoltageV) * 100;
        vdOk = vdPct <= el.vdLimitBranchPct;
      }
      steps.push({
        expr: `${cable.csaMm2} mm² (Iz=${Iz.toFixed(1)} A): Ib ${ampOk ? '≤' : '>'} Iz${ampOk ? `, Vd=${vdPct.toFixed(2)}%` : ''}`,
        result: ampOk && vdOk ? 'pass' : 'fail',
      });
      if (ampOk && vdOk) {
        chosen = cable;
        break;
      }
    }

    return {
      value: chosen ? chosen.csaMm2 : null,
      pass: chosen !== null,
      severity: chosen ? undefined : 'violation',
      trace: {
        formula: 'smallest CSA where Ib ≤ Iz AND Vd% ≤ limit',
        inputs: {
          designCurrent: `${Ib.toFixed(1)} A`,
          length: `${input.lengthOneWay.in(meter).toFixed(1)} m`,
          phase,
          vdLimit: `${el.vdLimitBranchPct} %`,
          nominalVoltage: `${el.nominalVoltageV} V`,
        },
        steps,
        clause: ctx.jurisdiction.standardRef,
        assumptions: SIZE_ASSUMPTIONS,
      },
    };
  },
};
