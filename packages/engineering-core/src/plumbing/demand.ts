import { Quantity, qty, lps } from '../units/index.ts';
import type { JurisdictionPack } from '../jurisdiction/types.ts';

/** Estimating simultaneous water demand from fixture units (Doc 03 §2.1, plumbing spec §3.1). */

export interface FixtureCount {
  readonly type: string;
  readonly count: number;
}

/** Sum Water Supply Fixture Units for a set of fixtures, using the jurisdiction table. */
export function sumWsfu(fixtures: readonly FixtureCount[], pack: JurisdictionPack): number {
  let total = 0;
  for (const f of fixtures) {
    const w = pack.demand.wsfu[f.type];
    if (w === undefined) {
      throw new Error(`No WSFU value for fixture '${f.type}' in jurisdiction ${pack.id}`);
    }
    total += w * f.count;
  }
  return total;
}

/**
 * Probable simultaneous demand via Hunter's curve — a jurisdiction TABLE, interpolated piecewise-
 * linearly (the curve is not a closed formula). Accounts for diversity: not all fixtures run at
 * once. Above the table, clamps to the last anchor.
 */
export function hunterDemand(wsfu: number, pack: JurisdictionPack): Quantity {
  const anchors = pack.demand.hunterAnchors;
  if (wsfu <= anchors[0].wsfu) return qty(anchors[0].lps, lps);
  for (let i = 1; i < anchors.length; i++) {
    const a = anchors[i - 1];
    const b = anchors[i];
    if (wsfu <= b.wsfu) {
      const t = (wsfu - a.wsfu) / (b.wsfu - a.wsfu);
      return qty(a.lps + t * (b.lps - a.lps), lps);
    }
  }
  return qty(anchors[anchors.length - 1].lps, lps);
}
