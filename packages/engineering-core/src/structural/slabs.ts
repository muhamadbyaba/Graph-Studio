import type { Rule, TraceStep, RuleResult } from '../rules/rule.ts';
import type { JurisdictionPack } from '../jurisdiction/types.ts';

/**
 * Reinforced-concrete slab sizing (ACI 318-style, preliminary). A slab panel is a polygon; its two
 * principal spans come from the bounding box. Slab thickness is normally deflection-governed, so we
 * take the smallest catalog thickness meeting h ≥ Ls/ratio (ratio differs one-way vs two-way), then
 * compute the flexural steel for a 1 m strip: Mu = w·Ls²/8, As = Mu/(φ·fy·0.9d) ≥ As,min. Self-weight
 * (24 kN/m³) is added to the applied load. Decision-support only — final analysis/detailing is the
 * Engineer of Record's. All constants come from the jurisdiction pack.
 */

function struct(p: JurisdictionPack) {
  if (!p.structural) throw new Error(`Jurisdiction ${p.id} has no structural data`);
  return p.structural;
}

export interface SlabPoint { readonly x: number; readonly y: number; }
export interface SizeSlabInput {
  readonly corners: readonly SlabPoint[]; // polygon corners [m]
  readonly loadKnPerM2: number; // applied (superimposed) factored load [kN/m²]
}

/** Polygon area via the shoelace formula, plus the axis-aligned bounding box. */
function areaAndBox(pts: readonly SlabPoint[]) {
  let a2 = 0, minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i], q = pts[(i + 1) % pts.length];
    a2 += p.x * q.y - q.x * p.y;
    if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
  }
  return { area: Math.abs(a2) / 2, Lx: maxX - minX, Ly: maxY - minY };
}

export const sizeSlabRule: Rule<SizeSlabInput> = {
  id: 'structural.slab.size',
  discipline: 'structural',
  standardRef: 'RC one/two-way slab (ACI 318-style, deflection-governed) — jurisdiction pack — VERIFY',
  assumptions: ['Rectangular-ish panel (spans from bounding box)', 'Deflection-governed thickness', 'φ = 0.9 flexure', 'Self-weight 24 kN/m³'],
  evaluate(input, ctx): RuleResult {
    const t = struct(ctx.jurisdiction);
    const pts = input.corners;
    const { area, Lx, Ly } = areaAndBox(pts);
    const Ls = Math.min(Lx, Ly), Ll = Math.max(Lx, Ly);

    if (pts.length < 3 || area < 1e-6 || Ls < 1e-6) {
      return { value: null, pass: false, severity: 'violation', trace: { formula: 'slab panel', inputs: { area: `${area.toFixed(2)} m²` }, steps: [{ expr: 'panel', result: 'degenerate (need ≥3 non-collinear corners)' }], clause: ctx.jurisdiction.standardRef, assumptions: [] } };
    }

    const twoWay = Ll <= 2 * Ls + 1e-9; // ACI: two-way when long/short ≤ 2
    const ratio = twoWay ? t.slabSpanRatioTwoWay : t.slabSpanRatioOneWay;
    const hMin = (Ls * 1000) / ratio; // mm (deflection control)

    const steps: TraceStep[] = [];
    let h: number | null = null;
    for (const cand of t.slabThicknessCatalog) {
      const ok = cand >= hMin - 1e-6;
      steps.push({ expr: `${cand} mm`, result: ok ? `≥ ${hMin.toFixed(0)} mm min` : `< ${hMin.toFixed(0)} mm min` });
      if (ok) { h = cand; break; }
    }
    if (h === null) {
      return { value: null, pass: false, severity: 'violation', trace: { formula: 'h ≥ Ls/ratio', inputs: { shortSpan: `${Ls.toFixed(2)} m`, minThickness: `${hMin.toFixed(0)} mm` }, steps, clause: ctx.jurisdiction.standardRef, assumptions: ['Deflection-governed thickness exceeded the catalog'] } };
    }

    const selfW = 24 * (h / 1000); // kN/m²
    const w = input.loadKnPerM2 + selfW; // total factored load per m²
    const Mu = (w * Ls * Ls) / 8; // kN·m per metre width
    const d = h - t.slabCoverMm;
    const asReq = (Mu * 1e6) / (0.9 * t.fyMpa * 0.9 * d); // mm²/m
    const asMin = t.slabMinSteelRatio * 1000 * h; // mm²/m (temperature/shrinkage)
    const As = Math.max(asReq, asMin);

    return {
      value: h,
      pass: true,
      trace: {
        formula: 'h ≥ Ls/ratio (deflection) ; Mu = w·Ls²/8 ; As = Mu/(φ·fy·0.9d) ≥ As,min',
        inputs: {
          area: `${area.toFixed(2)} m²`,
          shortSpan: `${Ls.toFixed(2)} m`,
          longSpan: `${Ll.toFixed(2)} m`,
          type: twoWay ? 'two-way' : 'one-way',
          thickness: `${h} mm`,
          load: `${input.loadKnPerM2} + ${selfW.toFixed(2)} self = ${w.toFixed(2)} kN/m²`,
          Mu: `${Mu.toFixed(1)} kN·m/m`,
          steel: `≈ ${As.toFixed(0)} mm²/m${As === asMin ? ' (min)' : ''}`,
        },
        steps,
        clause: ctx.jurisdiction.standardRef,
        assumptions: ['Rectangular-ish panel — spans from bounding box', 'Deflection-governed thickness', 'φ = 0.9 flexure, self-weight 24 kN/m³'],
      },
    };
  },
};
