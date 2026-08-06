import { Quantity } from '../units/quantity.ts';
import { qty, mps } from '../units/index.ts';
import type { Rule, TraceStep } from '../rules/rule.ts';
import type { JurisdictionPack } from '../jurisdiction/types.ts';

/**
 * Gravity drainage sizing (Doc 03 §3, plumbing spec §3.10–3.11). Fixtures contribute Drainage
 * Fixture Units (DFU); a branch is sized from cumulative DFU via a table; minimum slope depends on
 * size; Manning's equation checks the self-cleansing velocity. Same Rule contract + traces as the
 * supply rules — all constants come from the jurisdiction pack.
 */

function pack_(p: JurisdictionPack) {
  if (!p.drainage) throw new Error(`Jurisdiction ${p.id} has no drainage data`);
  return p.drainage;
}

/** Smallest drain OD whose table row covers the cumulative DFU. A vertical stack uses the stack table
 * (higher DFU capacity per size) when the pack provides one. */
export function sizeDrainOd(dfu: number, pack: JurisdictionPack, isStack = false): number {
  const d = pack_(pack);
  const table = isStack && d.stackSizeTable ? d.stackSizeTable : d.sizeTable;
  for (const row of table) if (dfu <= row.maxDfu) return row.odMm;
  return table[table.length - 1].odMm;
}

/** Minimum slope [%] for a given drain size. */
export function minSlopePct(odMm: number, pack: JurisdictionPack): number {
  const t = pack_(pack);
  for (const r of t.minSlope) if (odMm < r.belowMm) return r.slopePct;
  return t.minSlope[t.minSlope.length - 1].slopePct;
}

/** Manning full-bore velocity: v = (1/n)·R^(2/3)·S^(1/2), R = d/4, S = slope. Returns m/s. */
export function manningVelocity(odMm: number, slopePct: number, n: number): Quantity {
  const d = odMm / 1000;
  const R = d / 4;
  const S = slopePct / 100;
  const v = (1 / n) * Math.pow(R, 2 / 3) * Math.sqrt(S);
  return qty(v, mps);
}

/* ---- rules ---- */

export interface SizeDrainInput {
  readonly dfu: number;
  /** True for a vertical stack — sized from the stack DFU table (more capacity per size). */
  readonly isStack?: boolean;
}
export const sizeDrainRule: Rule<SizeDrainInput> = {
  id: 'plumbing.drain.size',
  discipline: 'plumbing',
  standardRef: 'Drainage sizing by cumulative DFU — jurisdiction table — VERIFY',
  assumptions: ['DFU per the jurisdiction table', 'Branch/stack sized from cumulative DFU'],
  evaluate(input, ctx) {
    const d = pack_(ctx.jurisdiction);
    const isStack = input.isStack === true && d.stackSizeTable != null;
    const table = isStack ? d.stackSizeTable! : d.sizeTable;
    const od = sizeDrainOd(input.dfu, ctx.jurisdiction, input.isStack);
    const steps: TraceStep[] = table.map((r) => ({
      expr: `≤ ${r.maxDfu} DFU → Ø${r.odMm}`,
      result: input.dfu <= r.maxDfu ? 'selected' : 'skip',
    }));
    return {
      value: od,
      pass: true,
      trace: {
        formula: `smallest ${isStack ? 'stack' : 'horizontal drain'} size whose DFU capacity ≥ cumulative DFU`,
        inputs: { cumulativeDfu: String(input.dfu), kind: isStack ? 'vertical stack' : 'horizontal branch/drain' },
        steps,
        clause: ctx.jurisdiction.standardRef,
        assumptions: [isStack ? 'Vertical stack DFU table' : 'Horizontal drain DFU table'],
      },
    };
  },
};

/** Max DFU permitted at one branch interval of a stack of the given size (last row if unlisted). */
export function maxBranchIntervalDfu(odMm: number, pack: JurisdictionPack): number | null {
  const table = pack_(pack).branchIntervalMaxDfu;
  if (!table) return null;
  const row = table.find((r) => r.odMm === odMm) ?? table[table.length - 1];
  return row.maxDfu;
}

export interface StackBranchInput {
  readonly odMm: number; // stack size
  readonly perIntervalDfu: number; // DFU connected at the worst single branch interval
}
export const stackBranchRule: Rule<StackBranchInput> = {
  id: 'plumbing.drain.stackBranch',
  discipline: 'plumbing',
  standardRef: 'Max DFU per stack branch interval — jurisdiction table — VERIFY',
  assumptions: ['One branch interval = one storey of the stack'],
  evaluate(input, ctx) {
    const max = maxBranchIntervalDfu(input.odMm, ctx.jurisdiction);
    const pass = max == null ? true : input.perIntervalDfu <= max + 1e-9;
    return {
      value: max,
      pass,
      severity: pass ? undefined : 'violation',
      trace: {
        formula: 'require DFU at any branch interval ≤ stack-size limit',
        inputs: { stackSize: `Ø${input.odMm}mm`, perInterval: `${input.perIntervalDfu} DFU`, limit: max == null ? 'n/a' : `${max} DFU` },
        steps: [{ expr: 'per-interval DFU ≤ limit', result: max == null ? 'no limit table' : `${input.perIntervalDfu} ${pass ? '≤' : '>'} ${max}` }],
        clause: ctx.jurisdiction.standardRef,
        assumptions: ['One branch interval = one storey of the stack'],
      },
    };
  },
};

export interface DrainSlopeInput {
  readonly odMm: number;
  readonly slopePct: number;
}
export const drainSlopeRule: Rule<DrainSlopeInput> = {
  id: 'plumbing.drain.slope',
  discipline: 'plumbing',
  standardRef: 'Minimum drainage slope by pipe size — jurisdiction pack — VERIFY',
  assumptions: ['Uniform grade along the run'],
  evaluate(input, ctx) {
    const min = minSlopePct(input.odMm, ctx.jurisdiction);
    const pass = input.slopePct >= min - 1e-9;
    return {
      value: min,
      pass,
      severity: pass ? undefined : 'violation',
      trace: {
        formula: 'require slope ≥ minimum slope(size)',
        inputs: { size: `Ø${input.odMm}mm`, slope: `${input.slopePct}%`, minSlope: `${min}%` },
        steps: [{ expr: 'slope ≥ min', result: `${input.slopePct}% ${pass ? '≥' : '<'} ${min}%` }],
        clause: ctx.jurisdiction.standardRef,
        assumptions: ['Uniform grade along the run'],
      },
    };
  },
};

/** Vent sizing by cumulative DFU (its own jurisdiction table). */
export function sizeVentOd(dfu: number, pack: JurisdictionPack): number {
  const t = pack.vent;
  if (!t) throw new Error(`Jurisdiction ${pack.id} has no vent data`);
  for (const row of t.sizeTable) if (dfu <= row.maxDfu) return row.odMm;
  return t.sizeTable[t.sizeTable.length - 1].odMm;
}

export interface SizeVentInput {
  readonly dfu: number;
}
export const sizeVentRule: Rule<SizeVentInput> = {
  id: 'plumbing.vent.size',
  discipline: 'plumbing',
  standardRef: 'Vent sizing by cumulative DFU — jurisdiction table — VERIFY',
  assumptions: ['Vent sized from the DFU it protects'],
  evaluate(input, ctx) {
    const od = sizeVentOd(input.dfu, ctx.jurisdiction);
    return {
      value: od,
      pass: true,
      trace: {
        formula: 'smallest vent whose DFU capacity ≥ cumulative DFU',
        inputs: { cumulativeDfu: String(input.dfu) },
        steps: [{ expr: `DFU ${input.dfu}`, result: `Ø${od}mm selected` }],
        clause: ctx.jurisdiction.standardRef,
        assumptions: ['Vent sized from the DFU it protects'],
      },
    };
  },
};

export interface DrainVelocityInput {
  readonly odMm: number;
  readonly slopePct: number;
}
export const drainVelocityRule: Rule<DrainVelocityInput> = {
  id: 'plumbing.drain.velocity',
  discipline: 'plumbing',
  standardRef: "Manning self-cleansing velocity — jurisdiction pack — VERIFY",
  assumptions: ['Full-bore Manning approximation', 'n per jurisdiction pack'],
  evaluate(input, ctx) {
    const t = pack_(ctx.jurisdiction);
    const v = manningVelocity(input.odMm, input.slopePct, t.manningN);
    const vv = v.in(mps);
    const pass = vv >= t.selfCleansingMps;
    return {
      value: v,
      pass,
      severity: pass ? undefined : 'warn',
      trace: {
        formula: 'v = (1/n)·R^(2/3)·S^(1/2), R = d/4 ; require v ≥ self-cleansing',
        inputs: { size: `Ø${input.odMm}mm`, slope: `${input.slopePct}%`, n: String(t.manningN), min: `${t.selfCleansingMps} m/s` },
        steps: [{ expr: 'Manning v', result: `${vv.toFixed(3)} m/s ${pass ? '≥' : '<'} ${t.selfCleansingMps} m/s` }],
        clause: ctx.jurisdiction.standardRef,
        assumptions: ['Full-bore Manning approximation'],
      },
    };
  },
};
