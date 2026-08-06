/**
 * Bill of Quantities primitives (Doc 08 §2.6, plumbing spec §13). BOQ lines are *derived* from
 * the model, so they re-fold automatically on every edit. This module is discipline-agnostic:
 * each module maps its objects to lines; the roll-up/aggregation is shared.
 */

export interface BoqLine {
  readonly itemCode: string;
  readonly description: string;
  readonly unit: string;
  readonly qty: number;
  readonly rate?: number; // unit rate (currency per unit); undefined = unpriced
  readonly group?: string; // discipline grouping for a structured BOQ
}

/** Discipline group for a BOQ item, derived from its itemCode. */
export function groupOf(itemCode: string): string {
  if (itemCode.startsWith('PPR-OD') || itemCode.startsWith('PROD-')) return 'Plumbing — supply';
  if (itemCode.startsWith('DRAIN-OD')) return 'Plumbing — drainage';
  if (itemCode.startsWith('VENT-OD')) return 'Plumbing — vent';
  if (itemCode.startsWith('FIX-')) return 'Plumbing — fixtures';
  if (itemCode.startsWith('FIT-')) return 'Plumbing — fittings';
  if (itemCode.startsWith('CABLE-') || itemCode === 'ELEC-load') return 'Electrical';
  if (itemCode.startsWith('DUCT-') || itemCode === 'HVAC-diffuser') return 'HVAC';
  if (itemCode.startsWith('BEAM-') || itemCode.startsWith('COL-') || itemCode.startsWith('SLAB-')) return 'Structural';
  return 'Other';
}

export function round(n: number, digits = 3): number {
  const f = Math.pow(10, digits);
  return Math.round(n * f) / f;
}

/** Merge lines with the same itemCode by summing quantities; returns a stable, sorted list. */
export function aggregate(lines: readonly BoqLine[]): BoqLine[] {
  const byCode = new Map<string, BoqLine>();
  for (const line of lines) {
    const existing = byCode.get(line.itemCode);
    if (existing) {
      byCode.set(line.itemCode, { ...existing, qty: round(existing.qty + line.qty, 4) });
    } else {
      byCode.set(line.itemCode, { ...line });
    }
  }
  return [...byCode.values()].sort((a, b) => a.itemCode.localeCompare(b.itemCode));
}
