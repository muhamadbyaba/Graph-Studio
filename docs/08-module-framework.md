# 08 — Module Framework & the Engineering Core

> **Purpose.** Plumbing is the first discipline module, but it must not be a one-off. This
> document defines the **reusable contract** every discipline implements — Electrical, HVAC,
> Drainage, Ceramic, Limestone, Paint, Structural, … — so a new module is *configuration +
> discipline rules*, not a new architecture. The Plumbing/PPR spec
> ([modules/plumbing-ppr.md](modules/plumbing-ppr.md)) is the first concrete instance of this
> contract; read this first, then read Plumbing as the worked example.

## 0. The prime directive

> **Every new feature must strengthen the Engineering Core — never fork it.**

Concretely: when a module needs a capability the core lacks (e.g., a network flow solver, a
thermal-expansion rule pattern, a "count derived accessories" BOQ rule), that capability is
added **to the shared core as a reusable primitive** and the module *consumes* it. Modules may
not privately reimplement units, rules, propagation, BOQ, cost, validation, events, or copilot
plumbing. This is enforced socially (review) and structurally (modules only get the core via its
interfaces; there is no back door). The result: every discipline shipped makes the next one
cheaper, and the platform converges instead of sprawling.

## 1. The Engineering Core (shared services — built once)

These live below every module and are the platform's crown jewels (Doc 02 §3):

| Core service | Responsibility | Modules do NOT reimplement |
|--------------|----------------|----------------------------|
| **Units & Quantity** | Typed quantities, dimensional analysis, unit-safe math, mm/imperial round-trip | Any arithmetic on physical values |
| **Rule Engine** | Pure, versioned, jurisdiction-parameterized rules returning `{value, pass, trace}` (Doc 03 §1) | Any engineering calculation |
| **Propagation Graph** | Reactive dependency graph; incremental dirty-set recompute (Doc 02 §3.1) | Change detection / recompute |
| **Event Store** | Append-only domain events → version history, undo/redo, audit (Doc 02 §4) | Persistence of changes |
| **Systems & Connectivity** | Typed ports + edges; network tracing; graph queries | Connection modelling |
| **BOQ Engine** | Maps object-derived quantities → line items; waste; grouping | Quantity roll-up |
| **Cost Engine** | Rate lookup (region/date-stamped DB), labor from productivity, build-up | Costing |
| **Validation Service** | Runs a module's rule set, aggregates severity, produces the fix queue | Validation orchestration |
| **Copilot Tool Bus** | Registers typed tools; enforces the "numbers only from tools" guardrail (Doc 06) | AI orchestration |
| **Import/Export Adapters** | IFC/DWG/PDF/glTF/Excel pipelines; modules supply entity mappings only | File I/O |
| **Report Engine** | Template → deliverable (calc reports, drawings, schedules, submittals) | Document generation |
| **Geometry/Viewport** | web-ifc/OCCT/Three.js; snapping, grids, levels, sections (Doc 02, Doc 04) | Rendering / CAD interaction |

## 2. The Module Contract (what every discipline implements)

A module is a package that registers the following against the core. Nothing more, nothing less.

```ts
interface DisciplineModule {
  id: string;                       // "plumbing", "electrical", "hvac", "finishes.ceramic"
  objectTypes: ObjectTypeDef[];     // §2.1
  connectivity: ConnectivityModel;  // §2.2 (ports, valid connections) — optional for non-network modules
  rules: Rule[];                    // §2.3 (Doc 03 §1) — jurisdiction-parameterized
  derived: DerivedPropertyDef[];    // §2.4 — feeds the propagation graph
  validations: ValidationDef[];     // §2.5 — rule → severity → fix hint
  boqMappings: BoqMappingDef[];     // §2.6 — object → quantity line(s)
  copilotTools: ToolDef[];          // §2.7 — typed, guardrailed
  ioAdapters: { ifc?: IfcMap; dwg?: DwgMap; pdf?: PdfMap; export?: ExportMap }; // §2.8
  ui: { inspectorSchema; tools; symbols; views };  // §2.9
  reports: ReportTemplate[];        // §2.10
}
```

### 2.1 Object types
Every smart object is an instance of a registered `ObjectTypeDef`:
```ts
interface ObjectTypeDef {
  type: string;                     // "PipeSegment", "Fixture", "Valve", "Cable", "Duct", "TileArea"
  category: "linear" | "point" | "area" | "volume" | "equipment" | "assembly";
  geometryKind: "polyline3d" | "point" | "surface" | "solid" | "symbol2d";
  properties: PropertySchema;       // unit-typed; identity | geometry | material | engineering | cost | lifecycle | meta
  ports?: PortDef[];                // connection points (for network categories)
  defaults: Partial<Properties>;    // sensible starting values
  editable: EditVerbs;              // which of move/rotate/resize/split/merge/reconnect/replace apply
}
```
The base property groups are **universal** (Doc 02 §4.2): `identity, geometry, material,
engineering (derived+validated), cost, connections, dependencies, lifecycle, meta{locked,
ai_generated, version}`. A module only declares its *discipline-specific* fields inside these
groups — the shape is shared.

### 2.2 Connectivity model (network modules)
```ts
interface PortDef { id: string; role: string; medium: string; size?: Quantity; direction?: "in"|"out"|"bi"; }
interface ConnectivityModel {
  ports: Record<ObjectType, PortDef[]>;
  rules: (a: Port, b: Port) => ConnectResult;   // is this connection valid? what fitting is implied?
  autoReconnect: boolean;                        // reconnect on move (Doc 01 hard requirement)
}
```
- **Medium** generalizes: plumbing=`water.cold|water.hot|drainage|vent`; electrical=`power|data`;
  HVAC=`air.supply|air.return|chilled.water`. The *graph* machinery is identical.
- **Area/finish modules** (ceramic, paint) declare **no ports** — they attach to host surfaces
  instead. Same contract, connectivity simply omitted.

### 2.3 Rules — see Doc 03 §1
Pure `evaluate(inputs) → {value, pass, severity, trace}`, `{jurisdiction, version}`-tagged,
units-enforced, trace-mandatory. The engine, tables, and jurisdiction packs are core; the
module supplies the discipline's rule definitions and its jurisdiction constant tables.

### 2.4 Derived properties (drive propagation)
```ts
interface DerivedPropertyDef {
  onType: ObjectType; name: string;                 // e.g. "flow_lps", "velocity_ms", "load_A"
  dependsOn: DependencySelector[];                   // other objects/props (upstream/downstream/host)
  compute(ctx): Quantity;                            // pure; usually calls a Rule
}
```
The propagation graph (core) reads `dependsOn`, computes the **dirty set** on any edit, and
recomputes **only** affected derived properties, topologically ordered. Modules never write
change-detection code — they only declare dependencies.

### 2.5 Validation
```ts
interface ValidationDef { id; onType; rule; severity: "info"|"warn"|"violation"; fixHint?: FixSuggestion; }
```
Runs automatically post-propagation; produces the **fix queue** the UI and copilot consume.

### 2.6 BOQ mapping
```ts
interface BoqMappingDef {
  onType: ObjectType;
  lines(obj): BoqLine[];        // one object → 1..n lines (e.g. pipe → pipe length + implied joints + supports)
  wasteKey: string;             // looks up region/project waste factor
  unit: Unit; groupBy: string[];
}
```
BOQ lines are **derived properties too** — they re-fold automatically on every edit (Doc 03 §8).

### 2.7 Copilot tools
```ts
interface ToolDef { name; inputSchema; outputSchema; sideEffect: "read"|"propose"|"apply"; run(args); }
```
Registered on the Tool Bus (Doc 06). `apply` tools require human confirmation; every numeric
output must originate here, never from the LLM. Common tool *shapes* are shared across modules:
`autoRoute/autoLayout`, `size`, `validate`, `optimize`, `explain`, `suggestFix`.

### 2.8 Import/export adapters
A module supplies only the **entity mapping** (e.g., `IfcPipeSegment ↔ PipeSegment`); the core
runs the pipeline, geometry conversion, and round-trip tests (Doc 07 §3).

### 2.9 UI descriptors
A module declares its **inspector schema** (grouped, unit-aware fields), its **viewport tools**
(place/route/insert), its **2D symbols/line styles**, and its **views** (plan / schematic /
isometric / section). The core renders them; the interaction model (snapping, precise entry,
manual-edit verbs, validation chips, BOQ strip) is shared (Doc 04).

### 2.10 Reports
Templates that bind model facts + rule traces → deliverables. The calc-report, schedule, BOQ,
compliance, and submittal **templates are shared shells**; a module supplies its content bindings.

## 3. Generic event taxonomy (event-sourced core)

Modules emit these **generic** events (discipline lives in the payload, not new event types):
`ObjectCreated · PropertyChanged · ObjectMoved · ObjectResized · ObjectSplit · ObjectMerged ·
ObjectConnected · ObjectDisconnected · ObjectReplaced · ObjectDeleted · ObjectLocked/Unlocked ·
SystemAssigned · SizingComputed · ValidationRun · BoqRecomputed`. A discipline adds a *payload
schema*, not a new event class, unless a genuinely novel semantic exists (rare). This keeps
version history, undo/redo, and audit uniform across all modules.

## 4. Generic persistence pattern (Doc 02 §4)

- **Event store**: append-only, per project. Source of truth.
- **Materialized `objects`** table: common typed columns (`id, project_id, type, discipline,
  system_id, geometry(PostGIS), locked, ai_generated, version`) + **`props JSONB`** for
  discipline fields + **`engineering JSONB`** (derived+traces) + **`cost JSONB`**.
- **`connections`** edge table: `(from_object, from_port, to_object, to_port, medium)`.
- **`systems`** table: a named network/collection within a discipline.
- **`validations`**, **`boq_lines`**, **`cost_rates`**, **`rules_catalog`** — all shared.
Adding a discipline adds **rows and JSONB shapes, not tables**.

## 5. Generic API pattern (Doc 02 §5)

- **GraphQL**: `object(id)`, `system(id)`, `objectsInView(bbox, disciplines)`,
  `validations(projectId, severity)`, `boq(projectId, groupBy)`, `trace(objectId, prop)`.
- **Mutations** are thin: they emit events; the read model + propagation update reactively.
- **Tool API**: the same mutations, exposed to the copilot with `propose/apply` semantics.
The *schema* is generated per module from its `ObjectTypeDef`s — one pattern, N disciplines.

## 6. The reuse matrix (why this generalizes)

| Contract slot | Plumbing | Electrical | HVAC | Ceramic / Paint (finish) |
|---------------|----------|------------|------|--------------------------|
| **Linear object** | Pipe segment | Cable / conduit | Duct | *(none)* |
| **Point/terminal** | Fixture, valve | Outlet, luminaire, breaker | Diffuser, VAV | *(none)* |
| **Area object** | *(none)* | *(none)* | *(none)* | Tile area / painted surface |
| **Medium/flow** | water/drainage/vent | current | air/chilled water | *(host surface)* |
| **Sizing rule** | pipe Ø (velocity/friction) | conductor CSA (ampacity/Vd) | duct size (equal-friction) | layers/coats |
| **Network solver** | pressure/flow balance | load/voltage-drop | airflow balance | *(none — area roll-up)* |
| **Key derived qty** | length, joints, fittings | length, terminations | length, fittings | area, tiles, liters |
| **Validation** | velocity/pressure/slope/PN | Ib≤In≤Iz / Vd% | velocity/friction | coverage/waste |
| **BOQ pattern** | length + count + accessories | length + count + accessories | length + count | area + count + consumable |
| **Copilot tools** | autoRoute/size/validate/optimize | autoRoute/size/validate/optimize | autoLayout/size/validate | autoLayout/quantify |

Every column implements the **same ten contract slots**. Finish modules simply drop the
network slots and use the area/host pattern. **This table is the promise of the blueprint:** a
new discipline fills these slots and inherits everything else.

## 7. What Plumbing must contribute back to the Core

Building Plumbing first will surface primitives the Core must own so later modules reuse them
(this is the prime directive in action). Expected contributions:
- **Network flow/pressure solver** (generic graph solve; Electrical reuses for load/Vd, HVAC for
  airflow).
- **Thermal-expansion rule pattern** (PPR expansion; reused by ducts, cable trays).
- **"Implied accessory count" BOQ primitive** (joints/supports derived from geometry; reused by
  every linear discipline).
- **Support-spacing-from-diameter table pattern** (reused by conduit/duct hangers).
- **Riser/isometric/schematic view generators** (reused by all MEP).
Each ships as a **core** capability, not plumbing-private code.

## 8. Definition of "module done" (extends Doc 05 §7)

A module is done when all ten contract slots are implemented, its rules pass the golden set for
the pinned jurisdiction (Doc 07 §2), propagation + BOQ + cost update live, IFC round-trips,
copilot tools are registered + guardrailed, the inspector/validation/views render, reports
generate, a11y + perf budgets hold, and **any new capability it needed was landed in the Core**,
not the module.
