# 03 — Engineering Rules Library

> **Ground rule (from Doc 00 §6): no guessing, no fake numbers.** Every rule is a pure
> function that returns a value, a pass/fail, **and a trace** (formula + inputs + intermediates
> + code clause + assumptions). The trace is simultaneously the engineer's justification, the
> AI's explanation, and the liability record. Rules are **versioned and jurisdiction-tagged**;
> a project pins `{jurisdiction, version}`. **All standards named below must be verified against
> the adopted local code and worked reference cases (Doc 07) before production use** — treat the
> constants here as the *structure* of the rules, confirmed per jurisdiction, not as gospel.

## 1. Rule anatomy

```ts
interface Rule<I, O> {
  id: string;                 // e.g. "plumbing.supply.velocity_limit"
  discipline: string;
  jurisdiction: string;       // "GULF" | "SBC" | "IPC" | "NEC" | "IEC" | "EUROCODE" ...
  version: string;            // semver; pinned per project
  standardRef: string;        // clause citation
  assumptions: string[];      // explicit, surfaced to the user
  inputs: UnitTypedSchema<I>;  // units enforced — never bare floats
  evaluate(i: I): {
    value: Quantity; pass?: boolean; severity?: "info"|"warn"|"violation";
    trace: { formula: string; inputs: Record<string,Quantity>;
             steps: {expr: string; result: Quantity}[]; clause: string };
  };
}
```
**Units are enforced by a units library** (mm vs m vs in; L/s vs gpm; kW vs BTU/h). A units
mismatch is a rejected input, not a silent error. This one rule prevents the entire class of
"metric/imperial" failures.

---

## 2. Plumbing — Water Supply

### 2.1 Demand estimation (fixture units → design flow)
- Assign **Water Supply Fixture Units (WSFU)** per fixture (code table), sum per branch.
- Convert cumulative WSFU → **probable simultaneous demand (Q)** via **Hunter's curve**
  (probabilistic; accounts for diversity — not all fixtures run at once).
- *Ref: IPC Appendix E / Hunter's method; confirm local table.*

### 2.2 Pipe friction loss — **Hazen–Williams** (SI)
```
hf = 10.67 · L · Q^1.852 / ( C^1.852 · D^4.87 )
```
`hf` head loss [m], `L` length [m], `Q` flow [m³/s], `D` internal diameter [m],
`C` roughness coefficient (dimensionless): **PPR/PEX/plastic ≈ 150**, copper ≈ 130–140,
galvanized steel ≈ 100–120. (Darcy–Weisbach is an alternative for higher accuracy.)

### 2.3 Velocity check
```
v = 4Q / (π · D²)
```
Typical limit **1.2–2.4 m/s** (cap hot water lower, ~1.5 m/s, to limit erosion/noise) —
*confirm per code/manufacturer.* Too low → sedimentation; too high → noise, water hammer, erosion.

### 2.4 Fitting (minor) losses
```
hf_minor = K · v² / (2g)          // or equivalent-length method
```
`K` per fitting type (elbow, tee, valve). Sum with pipe friction.

### 2.5 Pressure balance (system check)
```
P_source  ≥  ρ·g·Δh (static lift)  +  Σ hf (friction+fittings)  +  P_residual_required
```
Fails if any fixture can't meet its minimum residual pressure. If it fails → recommend larger
pipe, a booster pump, or a rooftop-tank gravity head recalculation (common in Gulf villa
practice). **This is a propagation trigger** (Doc 02 §3.1): change a fixture → re-solve the branch.

---

## 3. Plumbing — Drainage (gravity)

### 3.1 Load & sizing
- Assign **Drainage Fixture Units (DFU)** per fixture; size stacks/branches from DFU tables.

### 3.2 Minimum slope
Common practice: **1% (1:100)** for pipes ≥ 75 mm; **2% (1:50)** for < 75 mm
(*IPC: ⅛ in/ft ≈ 1% for 3″–6″; ¼ in/ft ≈ 2% for ≤ 2½″ — confirm local code*).

### 3.3 Gravity flow — **Manning's equation**
```
Q = (1/n) · A · R^(2/3) · S^(1/2)          R = A / P (hydraulic radius)
```
`n` roughness (PVC ≈ 0.009–0.011, cast iron ≈ 0.013), `A` flow area, `P` wetted perimeter,
`S` slope. **Self-cleansing velocity ≥ ~0.6 m/s**; avoid excessive velocity. Pipes sized to run
partially full (e.g. ≤ half to ¾ full for horizontal drains).

---

## 4. Electrical — Power

### 4.1 Load estimation
```
Design load = Σ (connected load × demand factor)      per panel/feeder
```
Demand factors per code + usage type (lighting, sockets, HVAC, motors).

### 4.2 Device / conductor coordination (IEC 60364)
```
Ib ≤ In ≤ Iz          Ib = design current, In = protective device rating, Iz = cable ampacity
```
`Iz` from ampacity tables **with derating** for ambient temperature, grouping, and installation
method. (NEC equivalent uses Table 310.16 + correction factors.)

### 4.3 Breaker sizing — continuous loads (NEC)
```
OCPD rating ≥ 1.25 × continuous load ;   conductor ampacity ≥ 1.25 × continuous load
```

### 4.4 **Voltage drop**
Single-phase (AC, with reactance):
```
Vd = 2 · L · Ib · (R·cosφ + X·sinφ)
```
Three-phase:
```
Vd = √3 · L · Ib · (R·cosφ + X·sinφ)
```
Simplified resistive (sizing check):
```
Vd = 2·ρ·L·I / A   (1-φ)      Vd = √3·ρ·L·I / A   (3-φ)
```
`ρ` copper ≈ 0.0172 Ω·mm²/m @20 °C (use ≈ 0.0225 at operating temp for margin), `A` = conductor
CSA [mm²]. **Limits:** typically **≤ 3% for lighting / final branch, ≤ 5% total**
(NEC informational; IEC/BS 7671 similar) — *confirm jurisdiction.* Exceeds → upsize conductor.

### 4.5 Short-circuit withstand (adiabatic)
```
A ≥ √(I² · t) / k          // minimum conductor CSA for fault current I over time t
```
`k` per insulation/conductor type. Cable size = **max** of (ampacity, voltage-drop, short-circuit).

---

## 5. Lighting — Lumen (flux) method

```
N = (E · A) / (Φ · n · UF · MF)
```
`N` luminaires, `E` required illuminance [lux], `A` area [m²], `Φ` flux per luminaire [lm],
`n` lamps/luminaire, `UF` utilization factor (from **Room Index** + surface reflectances),
`MF` maintenance factor.
```
Room Index RI = (L · W) / ( Hm · (L + W) )        Hm = mounting height above work plane
```
Target `E` by space per **EN 12464-1 / IES** (e.g., office ≈ 500 lux, corridor ≈ 100 lux,
kitchen ≈ 300–500 lux). Also check **uniformity** and glare (UGR) — *phase 2*.

---

## 6. HVAC — Cooling/Heating Load & Air

> Proper load calc = **ASHRAE RTS** (commercial) / **Manual J** (residential): envelope
> conduction, solar, internal gains (people/lights/equipment), ventilation/infiltration, latent.
> v1 uses a transparent block-load method with documented assumptions; CFD/dynamic simulation is
> deferred (Doc 05).

### 6.1 Airflow from sensible load
```
SI:  Q_sensible [W]   = 1.23 · airflow[L/s] · ΔT[°C]
IP:  Q_sensible [BTU/h] = 1.08 · CFM · ΔT[°F]
```
### 6.2 Latent load
```
IP:  Q_latent [BTU/h] = 0.68 · CFM · ΔW[gr/lb]
```
### 6.3 Duct sizing (equal-friction method)
Target friction ≈ **0.8–1.0 Pa/m** (≈ 0.08–0.1 in.wg/100 ft); enforce velocity limits by
application (residential mains ≈ 3–5 m/s). Size ducts to hold constant friction rate.
### 6.4 Unit conversion
```
1 TR (ton refrigeration) = 3.517 kW = 12,000 BTU/h
```

---

## 7. Structural — Sizing level (not FEA)

> v1/2 does **code sizing checks**, not finite-element analysis. FEA is deferred (Doc 05).
> Structural output is **always** subject to Engineer-of-Record sign-off (Doc 00 §6).

### 7.1 Load combinations
```
ACI/ASCE 7 (LRFD):  U = 1.2 D + 1.6 L   (and other combinations)
Eurocode:           1.35 G + 1.5 Q
```
### 7.2 RC beam flexure (ACI, SI)
```
a  = As·fy / (0.85·f'c·b)
Mn = As·fy·(d − a/2)          require  φ·Mn ≥ Mu     (φ = 0.9 tension-controlled)
ρ  = As / (b·d)              enforce ρ_min ≤ ρ ≤ ρ_max
```
### 7.3 Shear (ACI, SI)
```
φVc = φ · 0.17 · √f'c · b · d     (φ = 0.75)     stirrups required where Vu > φVc
```
### 7.4 Serviceability (deflection)
```
Limits: L/360 (live, brittle finishes) , L/240 (total)
Quick depth sizing: simply-supported RC beam depth ≈ L/12 … L/16
```
### 7.5 Column
```
Pu ≤ φPn ; axial–moment interaction (P–M diagram) ; slenderness check
```

---

## 8. Estimation / Quantity Takeoff logic

Quantities are **derived properties** on the smart objects (Doc 02 §3.1) — so they update on
every edit automatically. Rules define *how* each is computed.

### 8.1 Core quantity formulas
```
Concrete volume  = Σ element solid volumes                       (+ waste 3–5%)
Rebar weight     = Σ (bar length · unit mass) ;  unit mass = d²/162 [kg/m], d in mm
                    e.g. Ø16 → 16²/162 = 1.58 kg/m
Pipe/cable length= Σ routed polyline lengths                     (+ waste ~5%)
Tile/finish area = surface area / coverage · (1 + waste 10%)
Paint            = area / spreading_rate · coats                 (+ waste ~5%)
Insulation/WP    = surface area · layers                         (+ waste)
```
### 8.2 Waste factors (defaults, editable per project/region)
tile ≈ 10% · paint ≈ 5% · concrete ≈ 3–5% · rebar ≈ 3–5% · pipe/fittings ≈ 5%.

### 8.3 Cost build-up
```
Line cost   = qty · (material_rate + labor_rate + equipment_rate)
Labor       = qty · productivity[man-hr/unit] · crew_rate
Project     = Σ line costs + overhead + profit% + tax + contingency
```
- **Cost database** is editable, region/date-stamped, and versioned. Every BOQ line traces to
  its object(s), quantity formula, and rate source. Change the design → BOQ + cost re-fold
  through propagation.

---

## 9. Jurisdiction parameterization (why this is architectural)

The **same formula shape** takes **different constants, tables, and limits** per jurisdiction:
- Plumbing: WSFU/DFU tables, slope minimums, velocity/pressure limits.
- Electrical: NEC (Table 310.16, 1.25 continuous) vs IEC 60364 (Ib≤In≤Iz, derating tables).
- Structural: ACI/ASCE 7 vs Eurocode load factors and formulas.
- Lighting: EN 12464-1 vs IES target lux.

So a rule is `(jurisdiction, version) → {formula, tables, limits, clause}`. The project pins one;
switching jurisdiction re-validates the whole model against the new set. **First jurisdiction:
MENA/Gulf (Doc 00 §5)** — build the framework so adding IPC/NEC/Eurocode later is data, not code.

## 10. Validation obligation

No rule ships until it **matches a worked reference calculation** (textbook/standard example or
licensed-engineer hand calc) in the golden test set (Doc 07 §2). Rules carry test coverage as a
release gate. This is how we earn — and keep — professional trust.
