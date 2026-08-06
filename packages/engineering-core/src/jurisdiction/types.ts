/**
 * A JurisdictionPack is DATA, not logic. Every code-specific constant lives here so that rule
 * functions stay identical across jurisdictions (Doc 03 §9). Adding IPC/NEC/Eurocode later means
 * adding another pack, not editing rules.
 */

export interface PprSize {
  readonly odMm: number;
  readonly pn: number;
  readonly sdr: number;
}

export interface HunterAnchor {
  readonly wsfu: number;
  readonly lps: number;
}

export interface CableSize {
  readonly csaMm2: number;
  readonly ampacityA: number;
  readonly resistanceOhmPerM: number;
}

export interface DrainSize {
  readonly maxDfu: number;
  readonly odMm: number;
}

export interface SlopeRule {
  readonly belowMm: number;
  readonly slopePct: number;
}

export interface JurisdictionPack {
  readonly id: string;
  readonly version: string;
  readonly standardRef: string;

  readonly supply: {
    readonly velocityLimitColdMps: number;
    readonly velocityLimitHotMps: number;
    readonly hazenWilliamsC_PPR: number;
    readonly minResidualKPa: number;
    readonly maxPressureKPa: number;
    /** Minor-loss K-factor per fitting type (h = K·v²/2g). Optional — absent ⇒ minor losses ignored. */
    readonly fittingK?: Readonly<Record<string, number>>;
    /** Branch (turn-off) K-factor for tee/cross fittings; used when the flow path turns ≥45° at the fitting. */
    readonly fittingKBranch?: Readonly<Record<string, number>>;
    /** Ascending by outer diameter — sizing walks this to find the smallest passing size. */
    readonly pprCatalog: readonly PprSize[];
  };

  readonly demand: {
    readonly wsfu: Readonly<Record<string, number>>;
    /** Hunter probable-demand table (ascending by wsfu); interpolated, not a formula. */
    readonly hunterAnchors: readonly HunterAnchor[];
  };

  /** Gravity drainage constants — present once the Drainage module is enabled for a pack. */
  readonly drainage?: {
    readonly dfu: Readonly<Record<string, number>>;
    /** cumulative DFU → minimum drain OD for a HORIZONTAL branch/drain (ascending by maxDfu). */
    readonly sizeTable: readonly DrainSize[];
    /** cumulative DFU → minimum OD for a VERTICAL stack (higher DFU capacity per size). Optional. */
    readonly stackSizeTable?: readonly DrainSize[];
    /** Per-size limit on DFU connected at ONE branch interval of a stack (rows: {odMm, maxDfu}). Optional. */
    readonly branchIntervalMaxDfu?: readonly DrainSize[];
    /** minimum slope by size band (first row whose belowMm > od wins). */
    readonly minSlope: readonly SlopeRule[];
    readonly manningN: number;
    readonly selfCleansingMps: number;
  };

  /** Vent sizing (by DFU) — present once the Vent module is enabled for a pack. */
  readonly vent?: {
    readonly sizeTable: readonly DrainSize[];
  };

  /** HVAC round-duct sizing — present once the HVAC module is enabled for a pack. */
  readonly hvac?: {
    readonly velocityLimitMps: number;
    readonly ductCatalog: readonly number[]; // round duct Ø [mm], ascending
  };

  /** Structural (RC beam) sizing — present once the Structural module is enabled for a pack. */
  readonly structural?: {
    readonly fcMpa: number; // concrete f'c
    readonly fyMpa: number; // steel fy
    readonly coverMm: number; // cover + bar allowance (d = h − cover)
    readonly depthCatalog: readonly number[]; // beam overall depths [mm], ascending
    readonly spanDepthRatio: number; // min depth = span / ratio (deflection control)
    readonly rhoMax: number; // max beam tension steel ratio
    readonly columnCatalog: readonly number[]; // square column sizes [mm], ascending
    readonly columnRhoMin: number; // min longitudinal steel ratio (ACI 318 §10.6.1)
    readonly columnRhoMax: number; // max practical longitudinal steel ratio
    readonly slabThicknessCatalog: readonly number[]; // slab thicknesses [mm], ascending
    readonly slabSpanRatioOneWay: number; // min thickness = short span / ratio (one-way)
    readonly slabSpanRatioTwoWay: number; // min thickness = short span / ratio (two-way)
    readonly slabCoverMm: number; // slab cover to reinforcement centroid
    readonly slabMinSteelRatio: number; // temperature/shrinkage min steel ratio
  };

  /** Electrical (power) constants — present once the Electrical module is enabled for a pack. */
  readonly electrical?: {
    readonly nominalVoltageV: number;
    readonly powerFactor: number;
    readonly vdLimitBranchPct: number;
    readonly deratingFactor: number;
    /** Ascending by CSA — cable sizing walks this to find the smallest passing conductor. */
    readonly cableCatalog: readonly CableSize[];
  };
}
