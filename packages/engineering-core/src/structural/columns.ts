import type { Rule, TraceStep } from '../rules/rule.ts';
import type { JurisdictionPack } from '../jurisdiction/types.ts';

/**
 * Reinforced-concrete tied column sizing (ACI 318-style, preliminary). For a short column under a
 * factored concentric axial load Pu, the design capacity is
 *     φPn(max) = φ · 0.80 · [ 0.85·f′c·(Ag − Ast) + fy·Ast ]      (tied column, φ = 0.65)
 * We pick the smallest square section from the catalog whose required longitudinal steel ratio ρ
 * (to carry Pu) stays within the code limits, then report the section, steel area and utilisation.
 * Decision-support sizing — slenderness, moments and detailing remain the Engineer of Record's.
 * All constants come from the jurisdiction pack ("jurisdiction is data, not code").
 */

function struct(p: JurisdictionPack) {
  if (!p.structural) throw new Error(`Jurisdiction ${p.id} has no structural data`);
  return p.structural;
}

export interface SizeColumnInput {
  readonly axialLoadKn: number; // factored axial load Pu [kN]
}

export const sizeColumnRule: Rule<SizeColumnInput> = {
  id: 'structural.column.size',
  discipline: 'structural',
  standardRef: 'RC tied column axial design (ACI 318-style) — jurisdiction pack — VERIFY',
  assumptions: ['Short tied column (slenderness not checked)', 'Concentric axial load', 'φ = 0.65, 0.80 factor (tied)'],
  evaluate(input, ctx) {
    const t = struct(ctx.jurisdiction);
    const cap = 0.65 * 0.80; // φ · 0.80 for a tied column
    const fc = t.fcMpa, fy = t.fyMpa;
    const Pu = Math.max(0, input.axialLoadKn) * 1000; // N
    const steps: TraceStep[] = [];
    let chosen: number | null = null, chosenAst = 0, chosenRho = 0, chosenPhiPn = 0;

    for (const b of t.columnCatalog) {
      const Ag = b * b; // mm²
      // Invert φPn(max)=Pu for Ast:  0.85 f′c Ag + Ast (fy − 0.85 f′c) = Pu/(φ·0.80)
      const astReq = (Pu / cap - 0.85 * fc * Ag) / (fy - 0.85 * fc);
      const rhoReq = astReq / Ag;
      const rho = Math.min(Math.max(rhoReq, t.columnRhoMin), t.columnRhoMax); // clamp into [ρmin, ρmax]
      const Ast = rho * Ag;
      const phiPn = cap * (0.85 * fc * (Ag - Ast) + fy * Ast); // N
      const ok = rhoReq <= t.columnRhoMax + 1e-9 && phiPn >= Pu - 1e-3;
      steps.push({
        expr: `${b}×${b}: ρ=${(rho * 100).toFixed(2)}%, As=${Ast.toFixed(0)} mm², φPn=${(phiPn / 1000).toFixed(0)} kN`,
        result: ok ? 'ok' : `needs ρ=${(rhoReq * 100).toFixed(1)}% > ${(t.columnRhoMax * 100).toFixed(0)}%`,
      });
      if (ok) { chosen = b; chosenAst = Ast; chosenRho = rho; chosenPhiPn = phiPn; break; }
    }

    const util = chosen ? Pu / chosenPhiPn : null;
    return {
      value: chosen,
      pass: chosen !== null,
      severity: chosen ? undefined : 'violation',
      trace: {
        formula: 'φPn(max) = φ·0.80·[0.85·f′c·(Ag − Ast) + fy·Ast], tied (φ = 0.65)',
        inputs: {
          Pu: `${input.axialLoadKn} kN`,
          fc: `${fc} MPa`,
          fy: `${fy} MPa`,
          section: chosen ? `${chosen}×${chosen} mm` : '—',
          reinforcement: chosen ? `≈ ${chosenAst.toFixed(0)} mm² (ρ=${(chosenRho * 100).toFixed(2)}%)` : '—',
          capacity: chosen ? `${(chosenPhiPn / 1000).toFixed(0)} kN` : '—',
          utilization: util != null ? `${(util * 100).toFixed(0)}%` : '—',
        },
        steps,
        clause: ctx.jurisdiction.standardRef,
        assumptions: ['Short tied RC column — slenderness not checked (preliminary)', 'Concentric axial load only', 'φ = 0.65, tied 0.80 factor'],
      },
    };
  },
};
