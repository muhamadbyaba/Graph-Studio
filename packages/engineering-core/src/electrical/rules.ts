import { ampere, volt, meter } from '../units/index.ts';
import { voltageDrop } from './electrics.ts';
import type { Phase } from './electrics.ts';
import type { Quantity } from '../units/quantity.ts';
import type { Rule } from '../rules/rule.ts';

/** Validation rules for power circuits (Doc 03 §4). Same Rule contract as every plumbing rule. */

export interface AmpacityCheckInput {
  readonly designCurrent: Quantity;
  readonly ampacityA: number;
}

export const ampacityCheckRule: Rule<AmpacityCheckInput> = {
  id: 'electrical.power.ampacity',
  discipline: 'electrical',
  standardRef: 'Ib ≤ Iz coordination (IEC 60364) — jurisdiction pack — VERIFY',
  assumptions: ['Ampacity includes the pack derating factor'],

  evaluate(input, ctx) {
    const Iz = input.ampacityA * (ctx.jurisdiction.electrical?.deratingFactor ?? 1);
    const Ib = input.designCurrent.in(ampere);
    const pass = Ib <= Iz;
    return {
      value: Iz,
      pass,
      severity: pass ? undefined : 'violation',
      trace: {
        formula: 'require Ib ≤ Iz (Iz = ampacity × derating)',
        inputs: { designCurrent: `${Ib.toFixed(1)} A`, ampacity: `${input.ampacityA} A`, Iz: `${Iz.toFixed(1)} A` },
        steps: [{ expr: 'Ib ≤ Iz', result: `${Ib.toFixed(1)} ${pass ? '≤' : '>'} ${Iz.toFixed(1)} A` }],
        clause: ctx.jurisdiction.standardRef,
        assumptions: ['Ampacity includes the pack derating factor'],
      },
    };
  },
};

export interface VoltageDropCheckInput {
  readonly designCurrent: Quantity;
  readonly lengthOneWay: Quantity;
  readonly resistanceOhmPerM: number;
  readonly phase?: Phase;
}

export const voltageDropCheckRule: Rule<VoltageDropCheckInput> = {
  id: 'electrical.power.voltageDrop',
  discipline: 'electrical',
  standardRef: 'Voltage-drop limit — jurisdiction pack — VERIFY',
  assumptions: ['Referenced to nominal voltage', 'Final-branch limit'],

  evaluate(input, ctx) {
    const el = ctx.jurisdiction.electrical;
    if (!el) throw new Error(`Jurisdiction ${ctx.jurisdiction.id} has no electrical data`);
    const vd = voltageDrop(input.designCurrent, input.lengthOneWay, input.resistanceOhmPerM, input.phase ?? 'single');
    const vdPct = (vd.in(volt) / el.nominalVoltageV) * 100;
    const pass = vdPct <= el.vdLimitBranchPct;
    return {
      value: vdPct,
      pass,
      severity: pass ? undefined : 'violation',
      trace: {
        formula: 'Vd = k·I·L·r ; Vd% = Vd/Vnom·100 ; require ≤ limit',
        inputs: {
          designCurrent: `${input.designCurrent.in(ampere).toFixed(1)} A`,
          length: `${input.lengthOneWay.in(meter).toFixed(1)} m`,
          nominalVoltage: `${el.nominalVoltageV} V`,
          limit: `${el.vdLimitBranchPct} %`,
        },
        steps: [{ expr: 'Vd% ', result: `${vdPct.toFixed(2)}% ${pass ? '≤' : '>'} ${el.vdLimitBranchPct}%` }],
        clause: ctx.jurisdiction.standardRef,
        assumptions: ['Referenced to nominal voltage', 'Final-branch limit'],
      },
    };
  },
};
