import type { JurisdictionPack } from './types.ts';
import { GULF_V1 } from './gulf.ts';

/**
 * US jurisdiction pack — v0.1 DRAFT. Deliberately built by spreading the Gulf pack and overriding
 * the constants that actually differ, so the delta is visible. This is the whole point of the
 * "jurisdiction is data, not code" design (Doc 03 §9): the SAME model re-validates under a different
 * pack with zero rule-logic change. ⚠ Every value [VERIFY] against the adopted US codes
 * (IPC/UPC + NEC + ACI 318).
 */
export const US_V1: JurisdictionPack = {
  ...GULF_V1,
  id: 'US',
  version: '0.1.0-draft',
  standardRef: 'Representative US practice (IPC/UPC + NEC + ACI 318) — VERIFY',

  supply: {
    ...GULF_V1.supply,
    velocityLimitColdMps: 2.4, // ~8 ft/s [VERIFY]
    minResidualKPa: 103, // ~15 psi [VERIFY]
    maxPressureKPa: 552, // ~80 psi [VERIFY]
  },

  // NEC residential is 120 V single-phase — dramatically changes voltage-drop % vs 230 V,
  // so cables re-size when you switch jurisdiction.
  electrical: { ...GULF_V1.electrical!, nominalVoltageV: 120 },

  // ACI: f'c ≈ 4000 psi (28 MPa), cover ≈ 1.5 in (40 mm).
  structural: { ...GULF_V1.structural!, fcMpa: 28, coverMm: 40 },
};
