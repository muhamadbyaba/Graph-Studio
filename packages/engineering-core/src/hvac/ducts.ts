import { velocity } from '../plumbing/hydraulics.ts';
import { qty, mm, mps, lps } from '../units/index.ts';
import type { Rule, TraceStep } from '../rules/rule.ts';
import type { Quantity } from '../units/quantity.ts';
import type { JurisdictionPack } from '../jurisdiction/types.ts';

/**
 * HVAC round-duct sizing (Doc 03 §6, velocity method). Air is just another fluid: the same
 * `velocity()` = 4Q/(π·d²) applies. Size the smallest catalog duct whose air velocity stays within
 * the limit. Constants come from the jurisdiction pack. (Equal-friction sizing is a later refinement.)
 */

function hvac(p: JurisdictionPack) {
  if (!p.hvac) throw new Error(`Jurisdiction ${p.id} has no HVAC data`);
  return p.hvac;
}

export function sizeDuctOd(airflow: Quantity, pack: JurisdictionPack): number | null {
  const t = hvac(pack);
  for (const d of t.ductCatalog) if (velocity(airflow, qty(d, mm)).in(mps) <= t.velocityLimitMps) return d;
  return null; // even the largest catalog duct exceeds the velocity limit
}

export interface SizeDuctInput { readonly airflow: Quantity; }
export const sizeDuctRule: Rule<SizeDuctInput> = {
  id: 'hvac.duct.size',
  discipline: 'hvac',
  standardRef: 'Velocity-method round-duct sizing — jurisdiction pack — VERIFY',
  assumptions: ['Round ducts', 'Low-velocity system', 'Catalog + limit per jurisdiction pack'],
  evaluate(input, ctx) {
    const t = hvac(ctx.jurisdiction);
    const steps: TraceStep[] = [];
    let chosen: number | null = null;
    for (const d of t.ductCatalog) {
      const v = velocity(input.airflow, qty(d, mm)).in(mps);
      const ok = v <= t.velocityLimitMps;
      steps.push({ expr: `Ø${d}: v = 4Q/(π·d²)`, result: `${v.toFixed(2)} m/s ${ok ? '≤' : '>'} ${t.velocityLimitMps} m/s` });
      if (ok) { chosen = d; break; }
    }
    return {
      value: chosen,
      pass: chosen !== null,
      severity: chosen ? undefined : 'violation',
      trace: {
        formula: 'smallest round duct where air velocity ≤ limit',
        inputs: { airflow: `${input.airflow.in(lps).toFixed(0)} L/s`, limit: `${t.velocityLimitMps} m/s` },
        steps,
        clause: ctx.jurisdiction.standardRef,
        assumptions: ['Round ducts, low-velocity'],
      },
    };
  },
};

export interface DuctVelocityInput { readonly airflow: Quantity; readonly diameter: Quantity; }
export const ductVelocityRule: Rule<DuctVelocityInput> = {
  id: 'hvac.duct.velocity',
  discipline: 'hvac',
  standardRef: 'Duct air velocity limit — jurisdiction pack — VERIFY',
  assumptions: ['Round duct, full flow'],
  evaluate(input, ctx) {
    const t = hvac(ctx.jurisdiction);
    const v = velocity(input.airflow, input.diameter);
    const vv = v.in(mps);
    const pass = vv <= t.velocityLimitMps;
    return {
      value: v,
      pass,
      severity: pass ? undefined : 'warn',
      trace: {
        formula: 'v = 4Q/(π·d²) ; require v ≤ limit',
        inputs: { airflow: `${input.airflow.in(lps).toFixed(0)} L/s`, diameter: `${input.diameter.in(mm).toFixed(0)} mm`, limit: `${t.velocityLimitMps} m/s` },
        steps: [{ expr: '4Q/(π·d²)', result: `${vv.toFixed(2)} m/s ${pass ? '≤' : '>'} ${t.velocityLimitMps} m/s` }],
        clause: ctx.jurisdiction.standardRef,
        assumptions: ['Round duct, full flow'],
      },
    };
  },
};
