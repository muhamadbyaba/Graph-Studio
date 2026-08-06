import type { JurisdictionPack } from './types.ts';

/**
 * Gulf jurisdiction pack — v0.1 DRAFT.
 *
 * ⚠ EVERY numeric constant below is REPRESENTATIVE and marked [VERIFY]. Before GA each must be
 * confirmed against the adopted code (SBC 701/702, local water authority) and the selected PPR
 * manufacturer's datasheet, then backed by a golden test and signed off by a licensed plumbing
 * engineer (Doc 07 §2, plumbing spec §16). The FORMULAS that consume this data are exact.
 */
export const GULF_V1: JurisdictionPack = {
  id: 'GULF',
  version: '0.1.0-draft',
  standardRef: 'Representative Gulf practice (SBC 701/702, IPC/IEC-influenced) — VERIFY',

  supply: {
    velocityLimitColdMps: 2.0, // [VERIFY]
    velocityLimitHotMps: 1.5, // [VERIFY]  (lower for hot to limit erosion/noise)
    hazenWilliamsC_PPR: 150, // [VERIFY]  smooth plastic
    minResidualKPa: 100, // [VERIFY]  ~1 bar residual at fixture
    maxPressureKPa: 500, // [VERIFY]  above this → PRV
    // Minor-loss K-factors per fitting (h = K·v²/2g), Crane TP-410 style. [VERIFY vs manufacturer]
    // fittingK = straight-through / fixed-turn value; fittingKBranch = flow turning off to a branch.
    fittingK: { elbow90: 0.9, elbow45: 0.4, tee: 0.6, cross: 0.6, coupling: 0.04, reducer: 0.4, union: 0.04, endcap: 0, transition: 0.4, valve: 0.2 },
    fittingKBranch: { tee: 1.8, cross: 1.8 },
    // PPR PN20, SDR ≈ 6 (id = od − 2·od/sdr). [VERIFY manufacturer wall thicknesses]
    pprCatalog: [
      { odMm: 20, pn: 20, sdr: 6 },
      { odMm: 25, pn: 20, sdr: 6 },
      { odMm: 32, pn: 20, sdr: 6 },
      { odMm: 40, pn: 20, sdr: 6 },
      { odMm: 50, pn: 20, sdr: 6 },
      { odMm: 63, pn: 20, sdr: 6 },
    ],
  },

  demand: {
    // Water Supply Fixture Units per fixture. [VERIFY against adopted table]
    wsfu: {
      WaterCloset: 2.2,
      Lavatory: 0.7,
      KitchenSink: 1.4,
      Shower: 1.4,
      Bathtub: 1.4,
      WashingMachine: 1.4,
      HoseBibb: 2.5,
    },
    // Hunter probable-demand curve, stored as an interpolated table. [VERIFY values]
    hunterAnchors: [
      { wsfu: 0, lps: 0 },
      { wsfu: 10, lps: 0.5 },
      { wsfu: 20, lps: 0.9 },
      { wsfu: 50, lps: 1.6 },
      { wsfu: 100, lps: 2.7 },
      { wsfu: 200, lps: 4.1 },
    ],
  },

  // Drainage (gravity) — representative values. [VERIFY: SBC 701 / local authority; DFU tables,
  // size tables, min slopes, Manning n for uPVC.]
  drainage: {
    dfu: { WaterCloset: 4, Lavatory: 1, KitchenSink: 2, Shower: 2, Bathtub: 2, WashingMachine: 3, HoseBibb: 0 }, // [VERIFY]
    sizeTable: [
      { maxDfu: 1, odMm: 40 },
      { maxDfu: 2, odMm: 50 },
      { maxDfu: 8, odMm: 75 },
      { maxDfu: 160, odMm: 110 },
    ], // horizontal branch/drain [VERIFY]
    // Vertical stacks carry more DFU per size than a horizontal drain (IPC 710.1(2)-style). [VERIFY]
    stackSizeTable: [
      { maxDfu: 2, odMm: 40 },
      { maxDfu: 6, odMm: 50 },
      { maxDfu: 48, odMm: 75 },
      { maxDfu: 240, odMm: 110 },
    ],
    // Max DFU permitted at any ONE branch interval of a stack of the given size. [VERIFY IPC 710.1(2)]
    branchIntervalMaxDfu: [
      { maxDfu: 1, odMm: 40 },
      { maxDfu: 3, odMm: 50 },
      { maxDfu: 20, odMm: 75 },
      { maxDfu: 90, odMm: 110 },
    ],
    minSlope: [
      { belowMm: 75, slopePct: 2 }, // < 75 mm → 2% (1:50)
      { belowMm: 1e9, slopePct: 1 }, // ≥ 75 mm → 1% (1:100)
    ], // [VERIFY]
    manningN: 0.011, // uPVC [VERIFY]
    selfCleansingMps: 0.6, // [VERIFY]
  },

  // Vent sizing by cumulative DFU. [VERIFY: SBC 701 vent tables]
  vent: {
    sizeTable: [
      { maxDfu: 8, odMm: 40 },
      { maxDfu: 24, odMm: 50 },
      { maxDfu: 84, odMm: 75 },
      { maxDfu: 256, odMm: 110 },
    ],
  },

  // HVAC round-duct sizing (low-velocity). [VERIFY: ASHRAE / SBC 501 velocity + sizes]
  hvac: {
    velocityLimitMps: 5, // [VERIFY]
    ductCatalog: [100, 125, 160, 200, 250, 315, 400, 500, 630], // round Ø mm [VERIFY]
  },

  // Structural RC beam sizing (ACI-style). [VERIFY: SBC 304 / ACI 318 — materials, min depth, ρ]
  structural: {
    fcMpa: 30, // [VERIFY]
    fyMpa: 420, // [VERIFY]
    coverMm: 50, // [VERIFY]
    depthCatalog: [300, 400, 500, 600, 750, 900], // mm [VERIFY]
    spanDepthRatio: 16, // simply-supported min depth = L/16 [VERIFY ACI Table 9.3.1.1]
    rhoMax: 0.02, // [VERIFY]
    columnCatalog: [250, 300, 350, 400, 450, 500, 600, 700], // mm square [VERIFY]
    columnRhoMin: 0.01, // ACI 318 §10.6.1 minimum longitudinal steel [VERIFY]
    columnRhoMax: 0.04, // practical max (ACI permits 0.08) [VERIFY]
    slabThicknessCatalog: [100, 125, 150, 175, 200, 225, 250, 300], // mm [VERIFY]
    slabSpanRatioOneWay: 20, // min h = Ls/20 simply-supported one-way [VERIFY ACI Table 7.3.1.1]
    slabSpanRatioTwoWay: 30, // min h = Ls/30 two-way (simplified) [VERIFY ACI 8.3.1.1]
    slabCoverMm: 25, // cover to bar centroid in a slab [VERIFY]
    slabMinSteelRatio: 0.0018, // temperature/shrinkage steel, fy 420 [VERIFY ACI 7.6.1.1]
  },

  // Electrical (power) — representative single-phase Gulf residential values. [VERIFY: SBC 401 /
  // adopted IEC 60364 tables, local electricity authority; conductor resistances at design temp.]
  electrical: {
    nominalVoltageV: 230, // [VERIFY]
    powerFactor: 0.9, // [VERIFY]
    vdLimitBranchPct: 3, // [VERIFY]  (final branch circuits)
    deratingFactor: 1.0, // [VERIFY]  ambient/grouping/installation correction
    // copper, resistance Ω/m at operating temp; ampacity A. [VERIFY installation method + table]
    cableCatalog: [
      { csaMm2: 1.5, ampacityA: 17.5, resistanceOhmPerM: 0.0121 },
      { csaMm2: 2.5, ampacityA: 24, resistanceOhmPerM: 0.00741 },
      { csaMm2: 4, ampacityA: 32, resistanceOhmPerM: 0.00461 },
      { csaMm2: 6, ampacityA: 41, resistanceOhmPerM: 0.00308 },
      { csaMm2: 10, ampacityA: 57, resistanceOhmPerM: 0.00183 },
      { csaMm2: 16, ampacityA: 76, resistanceOhmPerM: 0.00115 },
      { csaMm2: 25, ampacityA: 101, resistanceOhmPerM: 0.000727 },
    ],
  },
};
