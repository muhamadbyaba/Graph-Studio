# Module Spec — Plumbing / PPR (Canonical Reference Implementation)

> **Status:** the first discipline module and the **blueprint** for every module that follows.
> It implements the Module Contract ([../08-module-framework.md](../08-module-framework.md))
> against the Engineering Core, using the Engineering Rules Library
> ([../03-engineering-rules-library.md](../03-engineering-rules-library.md)) for the physics.
> Jurisdiction = **MENA/Gulf** ([../00-strategy-and-scope.md](../00-strategy-and-scope.md) §5).
>
> **Accuracy convention.** Formulas here are exact. Every *constant* is a **parameter loaded
> from the Gulf jurisdiction pack**, shown here as a representative starting value marked
> **[VERIFY]** — to be confirmed against the adopted code (SBC 701/702, local water authority)
> and the selected manufacturer's datasheet before GA. No number ships without a golden test
> (Doc 07 §2). This is the "no fake numbers" rule made operational.

---

## 1. Scope & sub-systems

The module covers building water services as **four connected networks** (each a `system` in the
core), plus equipment:

| Sub-system | Medium | Primary objects | Flow |
|------------|--------|-----------------|------|
| **Cold water supply** | `water.cold` | tank→pump→risers→branches→fixtures | pressurized |
| **Hot water supply (+ recirc)** | `water.hot`, `water.recirc` | heater→risers→branches→fixtures→return | pressurized |
| **Soil & waste drainage** | `drainage` | fixtures→traps→branches→stacks→drains | gravity |
| **Venting** | `vent` | traps→vent branches→vent stacks→terminal | air |

Equipment (tanks, pumps, heaters, PRVs, meters) attaches to these networks. **PPR** is the
supply piping standard (cold + hot); **uPVC/HDPE** for drainage/vent [VERIFY local practice].

---

## 2. Smart object catalog

Every object carries the universal property groups (Doc 02 §4.2: `identity, geometry, material,
engineering, cost, connections, dependencies, lifecycle, meta`). Below, only the
**discipline-specific** fields + **ports** are listed. `category`/`geometryKind` map to the
contract (Doc 08 §2.1).

### 2.1 Fixtures (point / terminal)
`WaterCloset · Lavatory · KitchenSink · Shower · Bathtub · Bidet · FloorDrain · HoseBibb ·
WashingMachineOutlet · WaterHeaterDraw · Urinal · CleanersSink · DrinkingFountain`
- **Fields:** `fixtureType, flushType(tank|flushometer), wsfu_cold, wsfu_hot, dfu, minResidual_kPa,
  connectionSize_cold, connectionSize_hot, connectionSize_drain, trapSize, mountHeight`.
- **Ports:** `cold(in)`, `hot(in)` (if applicable), `drain(out)`, implicit `vent` via trap.
- WSFU/DFU/min-residual are **table-driven from the jurisdiction pack** (§3.1).

### 2.2 Pipe segments (linear)
- **`SupplyPipe`** (PPR): `medium(cold|hot|recirc), material(PPR-R|PPR-FR), pn(10|16|20|25),
  od_mm, sdr, id_mm(derived), lengthMm(derived from geometry), roughnessC(=150 PPR [VERIFY]),
  insulation{material, thk_mm}, jointType(socketFusion|buttFusion|electrofusion)`.
  Derived engineering: `flow_lps, velocity_ms, headloss_m, designPressure_kPa, expansion_mm`.
- **`DrainPipe`** (uPVC/HDPE): `od_mm, id_mm, slope_pct, manningN(≈0.010 [VERIFY]),
  fillRatio(derived), capacity_lps(derived), velocity_ms(derived)`.
- **`VentPipe`**: `od_mm, developedLength_mm, dfuServed(derived)`.
- **Ports:** two endpoints per segment, medium-typed; auto-reconnect on move (Doc 08 §2.2).

### 2.3 Fittings (point, inline)
`Elbow(45/90) · Tee · Cross · Reducer · Coupling · Union · EndCap · TransitionFitting(PPR↔metal)`
- **Fields:** `fittingType, size(s), kFactor|equivLength_m [VERIFY table], jointType, insertMetal?`.
- Minor-loss `K` or equivalent length feeds §3.2. `TransitionFitting` (male/female threaded metal
  insert) is a distinct BOQ + failure-risk item (common leak point) — flagged in validation.

### 2.4 Valves & controls (point, inline)
`GateValve · BallValve · CheckValve · PRV(pressure-reducing) · AngleStop · MixingValve ·
BalancingValve · FloatValve(tank) · SolenoidValve`
- **Fields:** `valveType, size, kFactor [VERIFY], setPressure_kPa(PRV), function`.
- PRV objects **partition the pressure network** (§3.3) — downstream pressure is re-referenced.

### 2.5 Vertical & grouping
`Riser (vertical supply) · Stack (vertical drainage) · VentStack · Manifold/Distributor ·
FixtureGroup(assembly, e.g. a bathroom set) · BranchLine`.
- `FixtureGroup` is an **assembly** object (contains members) — the reusable pattern for
  "bathroom pod," later reused as "electrical room," "AHU zone," etc.

### 2.6 Equipment (equipment category)
- **`WaterTank`** (ground/roof): `capacity_L, material(GRP|PE|concrete), levels{low,high},
  baseElevation_m, fireReserve_L?`.
- **`Pump`/`BoosterSet`**: `dutyFlow_lps, dutyHead_m, efficiency, power_kW(derived), stages,
  npshRequired_m`.
- **`WaterHeater`**: `heaterType(electric|solar|gasInstant|heatPump), storage_L, recovery_kW,
  setTemp_C, standbyLoss_W`.
- **`SolarCollector`**: `area_m2, efficiency, tilt, orientation` (Gulf-relevant).
- **`PressureVessel/Accumulator`, `Meter`, `BackflowPreventer`, `ExpansionCompensator`,
  `PipeSupport/Hanger`, `Sleeve/Penetration`, `Cleanout/Inspection`, `Trap`.**

### 2.7 Non-graphical / derived accessories
`FusionJoint` (implied by segment+fitting connectivity), `PipeSupport` (implied by support-
spacing rule), `Sleeve` (implied at wall/slab penetrations). These are **derived BOQ objects**
— they are computed, not drawn (Doc 08 §7 "implied accessory count" primitive).

---

## 3. Engineering rules & calculations

All rules return `{value, pass, severity, trace}` (Doc 03 §1). Constants → jurisdiction pack.

### 3.1 Demand estimation — `plumbing.supply.demand`
1. **WSFU per fixture** from the Gulf table [VERIFY — representative]: WC(tank) 2.2 · Lavatory 0.7
   · KitchenSink 1.4 · Shower 1.4 · Bathtub 1.4 · WashingMachine 1.4 · HoseBibb 2.5.
   (Split into cold/hot fractions per fixture.)
2. **Cumulative WSFU** per branch/riser via connectivity graph (sum downstream).
3. **Probable simultaneous demand Q** via **Hunter's curve** — a **stored jurisdiction table**,
   interpolated (not a formula). Representative anchors (flush-tank) [VERIFY]:
   `10 WSFU→~0.5 L/s · 20→~0.9 · 50→~1.6 · 100→~2.7 · 200→~4.1`.
   *Rationale surfaced in the trace: diversity — not all fixtures run at once.*

### 3.2 Supply pipe sizing — `plumbing.supply.sizePipe`
Two coupled checks; the engine picks the **smallest PPR OD** passing both:
- **Velocity:** `v = 4Q/(πD²)` ≤ limit. Limits [VERIFY]: cold ≤ **2.0 m/s**, hot ≤ **1.5 m/s**,
  noise-sensitive ≤ 1.2 m/s. (Too low → stagnation/Legionella risk in hot; too high → noise,
  erosion, water hammer.)
- **Friction (Hazen–Williams, SI):** `hf = 10.67·L·Q^1.852 / (C^1.852·D^4.87)`, `C=150` (PPR).
- **Minor losses:** `Σ K·v²/(2g)` (or equivalent-length) from fittings/valves.
- `id_mm` per PPR OD + PN/SDR: `id = od − 2·(od/SDR)` (SDR6≈PN20, SDR7.4≈PN16, SDR11≈PN10).

### 3.3 Pressure / head balance — `plumbing.supply.pressureBalance`
Node-by-node along the network graph:
```
P_fixture = P_source − ρ·g·Δh − Σ hf(friction) − Σ hf(minor)
require:  minResidual ≤ P_fixture ≤ P_max        [VERIFY: minResidual≈100 kPa, P_max≈500 kPa]
```
- **Source** = roof-tank gravity head (`ρgΔh`, Gulf-typical) **or** booster set discharge.
- **Fail (too low)** → recommend upsize / booster / re-route (copilot suggestFix).
- **Fail (too high, low floors under a roof tank or booster)** → recommend **PRV**; PRV nodes
  re-reference downstream pressure. This is the **network-solver primitive** (Doc 08 §7).

### 3.4 PPR pressure class & temperature/time derating — `plumbing.supply.pnCheck`
PPR long-term strength derates with temperature over its 50-year design life (ISO 10508 service
classes; ISO 9080/12162 regression). Hoop-stress design:
```
σ_hoop = p·(D−e)/(2e)        →   p_allow = 2·σ_s·e/(D−e)
σ_s = MRS / C                 MRS(PP-R) ≈ 8.0 MPa @20°C/50yr [VERIFY grade];  C ≥ 1.25–1.5
```
At the **design temperature** (hot water: Class 2 ≈ 70°C, or per SBC [VERIFY]), use the
**temperature-reduced** long-term strength. Rule: `max system pressure (incl. surge) ≤ p_allow`
at design temp/life. Fail → higher PN or PPR-FR.

### 3.5 Thermal expansion & compensation — `plumbing.supply.thermalExpansion`
```
ΔL = α · L · ΔT
α(PPR-R) ≈ 0.15 mm/(m·°C) ;  α(PPR-FR) ≈ 0.03–0.05 mm/(m·°C)   [VERIFY manufacturer]
```
Hot-water PPR moves a lot (e.g. 4 m × ΔT 50 °C × 0.15 ≈ **30 mm**). Rule computes ΔL per straight
run and **requires compensation** (expansion loop/offset or fixed+sliding support layout):
```
flexible-arm length  Ls = C·√(d·ΔL)     C ≈ 30 for PP [VERIFY],  d,ΔL in mm
```
Emits `ExpansionCompensator`/support layout as derived objects → BOQ. (Reused later for ducts.)

### 3.6 Water hammer / surge — `plumbing.supply.surge`
```
Δp = ρ·a·Δv   (Joukowsky)      a = √( (K/ρ) / (1 + (K·D)/(E·e)) )
```
`K`=water bulk modulus ≈ 2.1 GPa; `E`(PPR) ≈ 800–900 MPa [VERIFY]. **PPR's low modulus damps
surge** vs. metal (a design advantage the trace should state). Rule flags fast-closing valves and
sizes **arrestors** where `p_static + Δp > p_allow` (ties to §3.4).

### 3.7 Hot water — heater & recirculation
- **Heater capacity** — `plumbing.hot.sizeHeater`: `Q = m·c_p·ΔT`, `c_p`=4.186 kJ/kg·°C;
  `recovery_kW = (V·ρ·c_p·ΔT)/(t_recovery·η)`. Storage sized to peak-hour hot demand [VERIFY].
- **Solar collector** — `plumbing.hot.sizeSolar` (Gulf-relevant): `A = (V·ρ·c_p·ΔT)/(H_solar·η_coll)`,
  `H_solar` = daily irradiation [VERIFY site data].
- **Recirculation** — `plumbing.hot.recirc`: return-loop heat loss `q = U·A·ΔT`; size recirc pump
  for loop flow to hold ΔT ≤ target (limits dead-leg wait + Legionella).

### 3.8 Storage tank sizing — `plumbing.supply.sizeTank`
```
V = N_persons · q_percapita · storage_days   (+ fireReserve if required)
q_percapita ≈ 200–300 L/person/day  [VERIFY water authority] ;  storage_days ≈ 1
```
Common Gulf split: ground tank (bulk) + roof tank (head). Roof-tank elevation feeds §3.3.

### 3.9 Pump / booster sizing — `plumbing.supply.sizePump`
```
H_total = H_static + Σhf(friction+minor) + P_residual/(ρg)
P_shaft_kW = ρ·g·Q·H_total / (η · 1000)     η ≈ 0.6–0.75 [VERIFY]
```
Check **NPSH available ≥ required**; recommend VFD booster for pressure stability.

### 3.10 Drainage — DFU, slope, gravity flow
- **DFU** per fixture from table [VERIFY]: WC 4 · Lavatory 1 · Shower 2 · KitchenSink 2 ·
  FloorDrain 2 · WashingMachine 3. Cumulative via graph → stack/branch size from table.
- **Slope** — `plumbing.drain.slope`: min **2% (1:50)** for `<75 mm`, **1% (1:100)** for `≥75 mm`
  [VERIFY SBC 701].
- **Gravity flow (Manning)** — `plumbing.drain.capacity`: `Q=(1/n)·A·R^(2/3)·S^(1/2)`, size for
  partial fill (≤ ½–¾), **self-cleansing v ≥ 0.6–0.7 m/s** [VERIFY]; flag over-velocity.
- **Stack sizing** — `plumbing.drain.stack`: by cumulative DFU + storeys (table).

### 3.11 Venting & trap seal — `plumbing.vent.size`
- Size vents by **DFU + developed length** table; type per topology (individual/common/wet/
  circuit/stack).
- Keep drainage pressure fluctuation within **±250 Pa (±25 mm water)** to protect the **50 mm
  trap seal** [VERIFY] (prevents siphonage/blow-back). Flag unvented traps and excess dead-legs.

### 3.12 Support spacing — `plumbing.supply.supportSpacing`
Spacing = f(OD, temperature) from a **table** [VERIFY manufacturer]. Representative PPR (cold /
hot, mm): OD20 600/400 · OD25 700/450 · OD32 800/500 · OD40 900/600 · OD50 1000/650 · OD63
1150/750. Emits `PipeSupport` derived objects along each run → BOQ (Doc 08 §7 primitive).

### 3.13 Worked micro-example (**runnable** — proves the trace)
*Cold branch to a villa bathroom (WC-tank + lavatory + shower), L = 6 m.* These numbers are
produced by the **reference implementation** in `packages/engineering-core`
(`examples/villa-branch.ts`) against the Gulf pack's current **[VERIFY]** constants:
- WSFU = 2.2 + 0.7 + 1.4 = **4.3** → Hunter demand ≈ **0.215 L/s** (diversity applied).
- Sizing walks the PPR catalog: **OD20 PN20** (id ≈ 13.3 mm) → `v = 4Q/(π·d²)` ≈ **1.54 m/s ≤ 2.0** ✓ → selected.
- Head loss (Hazen–Williams, C = 150, L = 6 m) ≈ **1.30 m** (excl. minor losses).
- Every value carries a full trace (formula + inputs + steps + clause + assumptions) — see the
  printed output of the example.
- *Note:* demand and selected size depend on the **[VERIFY]** Hunter/velocity constants; when
  those are confirmed against the adopted code, the numbers change **as data, not code**. (The
  sizing golden test instead feeds a fixed 0.35 L/s and selects OD25 — same rule, different input.)

---

## 4. Events (event-sourced; generic taxonomy per Doc 08 §3)

Emitted with a plumbing payload — **no new event classes** except where noted:
`ObjectCreated(fixture|pipe|valve|…) · PropertyChanged(diameter|pn|material|slope|setPressure) ·
ObjectMoved · ObjectResized · ObjectSplit(pipe→insert fitting/valve) · ObjectMerged ·
ObjectConnected/Disconnected(port,medium) · ObjectReplaced · ObjectDeleted · ObjectLocked ·
SystemAssigned(cold|hot|drain|vent) · SizingComputed · ValidationRun · BoqRecomputed`.
Plumbing-specific semantic events (payload-typed): `SystemRebalanced` (pressure/flow re-solved),
`ExpansionLayoutRegenerated`, `SupportsRegenerated`. Every event → version history, undo/redo,
audit (Doc 02 §4).

---

## 5. Validation catalog

| ID | Checks | Severity on fail | Fix hint (copilot) |
|----|--------|------------------|--------------------|
| `velocity.cold/hot` | v within limit | warn/violation | upsize OD |
| `pressure.residual` | P_fix ≥ min | violation | upsize / booster / reroute |
| `pressure.max` | P_fix ≤ max | violation | insert PRV |
| `pn.rating` | p_sys ≤ p_allow(T,50yr) | violation | raise PN / PPR-FR |
| `expansion.uncompensated` | ΔL run has compensation | violation | add loop/offset |
| `drain.slope` | slope ≥ min | violation | re-grade |
| `drain.selfcleansing` | v ≥ 0.6 m/s | warn | steepen / downsize |
| `drain.fill` | ≤ ¾ full | warn | upsize |
| `vent.trapseal` | fluctuation ≤ ±25 mm | violation | resize/add vent |
| `connectivity.orphan` | fixture lacks cold/drain/vent | violation | connect |
| `transition.leakrisk` | metal↔PPR transition count | info | consolidate |
| `clash` | pipe vs. structure/other MEP | warn/violation | reroute |
Aggregated into the **fix queue** (Doc 08 §2.5), shown as inspector chips + copilot targets.

---

## 6. Propagation map (what recomputes on what change)

The propagation graph (core) recomputes only the dirty set. Key edges (declared as
`DerivedPropertyDef`s, Doc 08 §2.4):

| Change | Recomputes (in order) |
|--------|-----------------------|
| Add/remove/move fixture | branch cumulative WSFU/DFU → demand Q → pipe sizing → velocity/pressure → PN → BOQ/cost |
| Resize/replace pipe | id → velocity → headloss → downstream pressure → PN → supports/expansion → BOQ |
| Change material/PN | id, roughnessC → velocity/headloss → pressure → BOQ |
| Move pipe (geometry) | length → headloss → pressure → supports count → expansion → BOQ |
| Insert valve/PRV | minor loss / pressure partition → downstream pressure re-solve → BOQ |
| Change slope (drain) | capacity/velocity/fill → self-cleansing → BOQ |
| Change tank elevation / pump duty | source head → whole-network pressure re-solve |
Everything terminates in **BOQ + cost** (they are derived too). Never O(model) — dirty-set only.

---

## 7. AI copilot workflow & tools

Follows propose→validate→explain (Doc 06 §3). **All numbers come from these tools, never the
LLM.** Registered on the Tool Bus (Doc 08 §2.7); `apply` needs human confirm.

| Tool | Side-effect | Contract |
|------|-------------|----------|
| `plumbing.autoRoute` | propose | `(fixtures[], source, constraints) → proposed network (pipes+fittings+risers)` |
| `plumbing.size` | read | `(network, jurisdiction) → sizes + traces` (calls §3.1–3.2) |
| `plumbing.pressureBalance` | read | `(network) → node pressures + pass/fail` (§3.3) |
| `plumbing.validate` | read | `(network) → violations[]` (§5) |
| `plumbing.optimize` | propose | `(network, objective: cost|headloss|joints) → alt network + Δ` |
| `plumbing.sizeEquipment` | read | tank/pump/heater sizing (§3.8–3.9, §3.7) |
| `plumbing.explain` | read | `(objectId, prop) → trace` (formula+inputs+clause+assumptions) |
| `plumbing.suggestFix` | propose | `(violationId) → change proposal + cost Δ` |
| `plumbing.applyChange` | apply | emits events (same path as human edits) |

**Copilot flow example:** import plan → `autoRoute` cold/hot to fixtures → `size` + `pressureBalance`
→ `validate` → posts a **proposal card** (routing, sizes, standards, assumptions, cost Δ,
alternatives, per-number traces) → engineer Accept/Modify/Reject/Lock. Guardrail: any numeric
claim without a tool source is rejected (Doc 06 §2). Red-team: prompt-injection via imported
fixture schedules is treated as data, not instruction (Doc 06 §6).

---

## 8. Database schema (concrete instance of Doc 08 §4)

Shared tables, plumbing lives in typed columns + JSONB — **no new tables**.

```sql
-- objects (materialized read model; source of truth = event store)
objects(
  id uuid pk, project_id uuid, type text,              -- 'SupplyPipe','WaterCloset',...
  discipline text default 'plumbing',
  system_id uuid,                                       -- FK systems (cold|hot|drain|vent)
  geometry geometry(GeometryZ, :srid),                 -- PostGIS
  props jsonb,          -- {medium, pn, od_mm, sdr, id_mm, roughnessC, slope_pct, insulation,...}
  engineering jsonb,    -- {flow_lps, velocity_ms, headloss_m, pressure_kPa, checks:[{rule,pass,trace}]}
  cost jsonb,           -- {qty, unit, material_cost, labor_cost, waste_pct}
  locked bool, ai_generated bool, version int
);
connections(from_object uuid, from_port text, to_object uuid, to_port text, medium text);
systems(id uuid pk, project_id uuid, discipline text, name text, kind text, source_ref uuid);
validations(id, project_id, object_id, rule_id, severity, pass bool, trace jsonb, created_at);
boq_lines(id, project_id, source_object_id, item_code, description, unit, qty,
          rate_ref uuid, material_cost, labor_cost, waste_pct, group_path text[]);
cost_rates(id, region, effective_date, item_code, material_rate, labor_rate, productivity);
rules_catalog(id, discipline, jurisdiction, version, standard_ref, params jsonb);
-- events (append-only)
events(seq bigserial, project_id, aggregate_id, type, payload jsonb, actor, ts);
```
Indexes: GiST on `geometry` (spatial/clash), btree on `system_id`, GIN on `props/engineering`.

---

## 9. API (concrete instance of Doc 08 §5)

**GraphQL (reads):**
```graphql
type SupplyPipe { id: ID! medium: Medium! pn: Int! odMm: Float! idMm: Float!
  lengthMm: Float! flowLps: Float velocityMs: Float headlossM: Float
  designPressureKPa: Float checks: [Check!]! connections: [Connection!]! cost: Cost! }
type Query {
  system(id: ID!): PlumbingSystem
  objectsInView(bbox: BBox!, disciplines: [String!]): [Object!]!
  validations(projectId: ID!, severity: Severity): [Validation!]!
  boq(projectId: ID!, groupBy: [String!]): [BoqLine!]!
  trace(objectId: ID!, prop: String!): Trace!          # formula+inputs+steps+clause
}
```
**Mutations** (thin → emit events; propagation reacts):
```graphql
placeFixture(...) · routePipe(...) · resizePipe(id, odMm, pn) · insertInline(pipeId, at, kind)
· setSlope(id, pct) · connect(a, b) · move(id, transform) · split(id, at) · merge(a, b)
· lock(id) · replace(id, newType)
```
**REST:** file upload/download, exports, webhooks. **Tool API:** the §7 tools = same mutations
with propose/apply semantics for the copilot. One schema, generated from `ObjectTypeDef`s.

---

## 10. UI interactions & views (per Doc 04)

**Views (view generators become core primitives, Doc 08 §7):**
- **Plan (2D)** — fixtures + routed pipes on the architectural underlay; discipline color per
  medium (cold=blue, hot=red, drain=green, vent=grey [design-token driven]).
- **3D** — coordinated model, clash-visible.
- **Riser diagram** — vertical schematic of risers/stacks per system.
- **Isometric** — per-branch plumbing isometric (standard deliverable).
- **Schematic / single-line** — logical network (tank→pump→risers→fixtures).

**Tools:** place-fixture, route-pipe (with snapping to grid/levels/fixtures, precise mm entry),
insert-fitting/valve (splits a pipe), slope-editor (drain, drag or type %), auto-route (copilot),
measure, section.

**Inspector (right panel):** grouped unit-aware fields (medium, PN, OD, material, insulation),
**live validation chips** (velocity/pressure/PN/slope) each opening the **TracePanel**, and the
object's **cost contribution**. Editing a field propagates instantly.

**Bottom strip:** live BOQ total + Δ-on-edit; validation rollup; copilot dock with proposal cards.

---

## 11. Manual editing behaviors (every verb → effect; hard requirement Doc 01 §5)

| Verb | Behavior + propagation |
|------|------------------------|
| **Move** fixture/pipe | geometry updates → connected pipes **auto-reconnect** → length/headloss/pressure/supports/expansion **re-solve** → BOQ/cost update |
| **Resize** pipe (OD/PN) | manual override **locks** the value; velocity/pressure/PN re-validate; if it now fails, chip turns red (never silently "corrected") |
| **Rotate** | geometry + symbol update; connections preserved |
| **Split** pipe | inserts node (place fitting/valve); two segments inherit props; joints recount |
| **Merge** collinear pipes | one segment; joints/supports recount |
| **Replace** (e.g. ball→gate valve) | swap type, re-solve minor loss/pressure |
| **Extend / trim** | length re-derives → headloss/pressure/BOQ |
| **Reconnect** | drag endpoint to a new port; validity checked (medium/size); auto-fitting proposed |
| **Delete** | disconnect neighbors; downstream demand/pressure re-solve; orphan warnings raised |
| **Lock** | value/geometry frozen; copilot may not modify; propagation respects it |
| **Undo/Redo** | event-store replay (Doc 02 §4) — always available, unlimited |
Every edit is an **event**; every event triggers **incremental propagation** (§6). AI edits use
the *same* verbs — no privileged path (Doc 06 §2).

---

## 12. Import / export

**Import:**
- **IFC** — map to internal objects:

  | IFC entity | Internal |
  |------------|----------|
  | `IfcPipeSegment` / `IfcFlowSegment` | `SupplyPipe` / `DrainPipe` |
  | `IfcPipeFitting` / `IfcFlowFitting` | `Fitting` |
  | `IfcValve` / `IfcFlowController` | `Valve` |
  | `IfcSanitaryTerminal` | `Fixture` |
  | `IfcTank` / `IfcFlowStorageDevice` | `WaterTank` |
  | `IfcPump` / `IfcFlowMovingDevice` | `Pump` |
  | `IfcDistributionPort` | `Port` (medium/size) |
  | `IfcSystem` / `IfcDistributionSystem` | `system` |

  Preserve Psets (`Pset_PipeSegmentTypeCommon`, etc.) into `props`. Round-trip tested (Doc 07 §3).
- **DWG/DXF** — 2D underlay (architectural reference; layers→discipline hints).
- **PDF** — vector: extract geometry/text as underlay; raster: AI-vision fixture/route detection
  **behind human review** (Doc 00 §4). Never an authoritative source until confirmed.

**Export deliverables:** IFC (plumbing systems, Psets, ports) · PDF drawings (plans, risers,
isometrics, schematics with title blocks + dimensions) · Excel/CSV BOQ (ties to model qty
exactly) · glTF (3D view) · calc report (PDF, §14). Determinism where the format allows (Doc 07 §3).

---

## 13. BOQ generation (object → line mapping; Doc 08 §2.6)

BOQ lines are **derived** → re-fold on every edit. Mapping:

| Object | BOQ line(s) | Unit | Notes |
|--------|-------------|------|-------|
| `SupplyPipe` | pipe by **OD × PN × medium** | m | + waste (pipe ≈ 5% [VERIFY]) |
| `Fitting` | by **type × size** | nr | includes elbows/tees/reducers/transitions |
| `Valve` | by **type × size** | nr | |
| `Fixture` | by **type** | nr | + connection accessories |
| **`FusionJoint`** (derived) | by **size**; count = f(segments, fittings) | nr | **labor driver** — fusion time per Ø |
| **`PipeSupport`** (derived, §3.12) | by **size**; count = length/spacing | nr | |
| `Insulation` | by **pipe run × thickness** | m | hot/recirc runs |
| `ExpansionCompensator` (derived, §3.5) | by size | nr | |
| `Sleeve/Penetration` (derived) | by size | nr | at wall/slab crossings |
| `WaterTank/Pump/Heater` | as equipment | nr | with spec |
| `DrainPipe` | by OD | m | + fittings, cleanouts |

**Labor** = `Σ qty · productivity(item) · crew_rate` — **fusion joints are the dominant PPR labor
line** (productivity per joint by diameter [VERIFY]). **Cost build-up** (Doc 03 §8.3): material +
labor + equipment, then overhead + profit + tax + contingency. Every line **traces to its source
object(s)** and quantity formula.

---

## 14. Report generation (per Doc 08 §2.10, shared shells)

- **Plumbing Design Calculation Report** — fixture schedule; demand calc (WSFU→Q, Hunter);
  pipe-sizing table with **traces**; pressure-balance node table; PN/expansion checks; drainage
  slope/stack/vent sizing; tank/pump/heater sizing. *Every number carries its formula + clause*
  (this is the liability record, Doc 00 §6).
- **Drawings** — plans, riser diagrams, isometrics, schematics (from §10 view generators).
- **BOQ Report** — §13, grouped, priced.
- **Compliance/Validation Report** — §5 results vs. SBC/authority clauses; open violations.
- **Material Submittal** — PPR grade/PN, fittings, valves, equipment specs + manufacturer data.
All human-reviewed before issue; stamped with jurisdiction/version + disclaimer (Doc 00 §6).

---

## 15. Reuse mapping — how Plumbing templates the next modules

This is the payoff (Doc 08 §6). Each future module fills the **same slots**:

| Slot | Plumbing (this doc) | Electrical | HVAC | Ceramic / Paint |
|------|---------------------|-----------|------|-----------------|
| Linear object | `SupplyPipe`/`DrainPipe` | `Cable`/`Conduit` | `Duct` | — |
| Terminal | `Fixture`/`Valve` | `Outlet`/`Luminaire`/`Breaker` | `Diffuser`/`VAV` | — |
| Area object | — | — | — | `TileArea`/`PaintedSurface` |
| Sizing rule | velocity+friction (§3.2) | ampacity+Vd | equal-friction duct | layers/coats/coverage |
| Network solver | pressure balance (§3.3) | load+voltage-drop | airflow balance | area roll-up |
| Derived accessories | joints/supports/sleeves | terminations/glands | flanges/hangers | grout/adhesive/primer |
| Validation | §5 catalog | Ib≤In≤Iz, Vd% | velocity/friction | coverage/waste |
| BOQ pattern | length+count (§13) | length+count | length+count | area+consumable |
| Copilot tools | §7 | same shapes | same shapes | autoLayout/quantify |
| Views | plan/riser/iso/schematic | plan/single-line/panel-schedule | plan/duct-iso | plan/finish-schedule |

Reused **core primitives Plumbing contributes** (Doc 08 §7): network flow/pressure solver,
thermal-expansion rule pattern, implied-accessory-count BOQ, support-spacing table pattern,
riser/isometric/schematic view generators. **The next module inherits all of these.**

---

## 16. Verification checklist (before GA — Doc 07 §2)

Confirm against **adopted Gulf codes + chosen manufacturer**, then lock into the jurisdiction
pack and back each with a golden test:
- [ ] WSFU / DFU tables (SBC 701/702 or local) · Hunter curve values
- [ ] Velocity limits (cold/hot/noise) · min/max residual pressure
- [ ] Hazen–Williams C, fitting K / equivalent lengths
- [ ] PPR grade **MRS**, design coefficient **C**, ISO 10508 service class + design temp
- [ ] Thermal expansion α (PPR-R vs PPR-FR) · expansion-loop constant · support spacing table
- [ ] Drainage slope minimums · Manning n · self-cleansing velocity · fill limit
- [ ] Stack/vent sizing tables · trap seal + pressure-fluctuation limit
- [ ] Per-capita demand · storage days · pump efficiency · heater ΔT/recovery · solar irradiation
- [ ] Waste factors · fusion-joint labor productivity by diameter
- [ ] **Licensed plumbing engineer sign-off** on the golden set (Doc 07 §2, §8).
