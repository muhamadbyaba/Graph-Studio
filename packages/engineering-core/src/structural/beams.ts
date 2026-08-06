import type { Rule, TraceStep } from '../rules/rule.ts';
import type { JurisdictionPack } from '../jurisdiction/types.ts';

/**
 * Reinforced-concrete beam sizing (Doc 03 §7, ACI-style, preliminary). For a simply-supported beam
 * with a uniform load: Mu = w·L²/8. Choose the smallest catalog depth meeting the deflection min
 * (h ≥ L/ratio); compute the required tension steel As ≈ Mu/(φ·fy·0.9d) and check ρ ≤ ρmax. This is
 * decision-support sizing — final design + detailing is the Engineer of Record's (Doc 00 §6).
 * All constants come from the jurisdiction pack.
 */

function struct(p: JurisdictionPack) {
  if (!p.structural) throw new Error(`Jurisdiction ${p.id} has no structural data`);
  return p.structural;
}

export interface SizeBeamInput {
  readonly spanM: number;
  readonly loadKnPerM: number;
}

export const sizeBeamRule: Rule<SizeBeamInput> = {
  id: 'structural.beam.size',
  discipline: 'structural',
  standardRef: 'RC beam flexure + deflection (ACI-style) — jurisdiction pack — VERIFY',
  assumptions: ['Simply-supported', 'Uniform load', 'φ = 0.9 flexure', 'lever arm ≈ 0.9d (preliminary)'],
  evaluate(input, ctx) {
    const t = struct(ctx.jurisdiction);
    const phi = 0.9;
    const Mu = 0.125 * input.loadKnPerM * input.spanM * input.spanM; // kN·m (wL²/8)
    const minDepth = (input.spanM * 1000) / t.spanDepthRatio; // mm
    const steps: TraceStep[] = [];
    let chosen: number | null = null;
    let chosenAs = 0;
    for (const h of t.depthCatalog) {
      const d = h - t.coverMm;
      const b = Math.max(250, Math.round(h / 2 / 50) * 50); // width ≈ h/2, rounded to 50 mm
      const As = (Mu * 1e6) / (phi * t.fyMpa * 0.9 * d); // mm² (Mu N·mm / (φ·fy·0.9d))
      const rho = As / (b * d);
      const depthOk = h >= minDepth - 1e-6;
      const rhoOk = rho <= t.rhoMax;
      const ok = depthOk && rhoOk;
      steps.push({
        expr: `h=${h} (d=${d}, b=${b}): As=${As.toFixed(0)} mm², ρ=${(rho * 100).toFixed(2)}%`,
        result: ok ? 'ok' : !depthOk ? `depth < ${minDepth.toFixed(0)} mm` : `ρ > ${(t.rhoMax * 100).toFixed(1)}%`,
      });
      if (ok) { chosen = h; chosenAs = As; break; }
    }
    return {
      value: chosen,
      pass: chosen !== null,
      severity: chosen ? undefined : 'violation',
      trace: {
        formula: 'Mu = wL²/8 ; h ≥ span/ratio ; As = Mu/(φ·fy·0.9d) ; ρ ≤ ρmax',
        inputs: {
          span: `${input.spanM.toFixed(2)} m`,
          load: `${input.loadKnPerM} kN/m`,
          Mu: `${Mu.toFixed(1)} kN·m`,
          minDepth: `${minDepth.toFixed(0)} mm`,
          reinforcement: chosen ? `≈ ${chosenAs.toFixed(0)} mm²` : '—',
        },
        steps,
        clause: ctx.jurisdiction.standardRef,
        assumptions: ['Simply-supported RC beam', 'φ = 0.9 flexure', 'lever arm ≈ 0.9d — preliminary sizing'],
      },
    };
  },
};
