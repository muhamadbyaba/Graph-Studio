# @buildgraph/engineering-core

The part of BuildGraph that knows engineering. Pure functions, no I/O, no framework, no runtime
dependencies — and no idea that a web server exists.

Everything that produces an engineering number in this project lives here. The application layer
above it validates requests, persists event logs and renders results; it never calculates.

```
src/
  units/         dimensionally safe Quantity: mm, m, L/s, A, V, kN. A number cannot lose its unit.
  core/          the reactive propagation graph — signals with automatic dependency tracking
  rules/         the Rule contract: pure (inputs, jurisdiction) -> { value, pass, trace }, + registry
  jurisdiction/  code packs (GULF, US) — every constant is data, swappable at runtime
  plumbing/      hydraulics, Hunter demand, supply sizing, drainage, vent, pressure, recirculation
  electrical/    voltage drop, ampacity, cable sizing
  hvac/          velocity-method duct sizing
  structural/    reinforced concrete beams, tied columns, deflection-governed slabs
  model/         the geometric layout model, topology and minimum-spanning-tree auto-routing
  events/        event sourcing: transactional, memoised history giving undo, audit and replay
  boq/           bill-of-quantities aggregation and costing, discipline-agnostic
  catalog/       the cross-discipline component library
  geometry/      horizontal section cut: an imported mesh to fitted 2D wall segments
  ai/            the tool bus and the numeric guardrail that keeps a model from inventing figures
```

## The four ideas

**Dimensional safety.** `Quantity` carries its dimension. Adding metres to litres per second
throws instead of producing a number that looks right. Millimetres and metres round-trip
losslessly.

```ts
qty(5, meter).plus(qty(2, lps));   // throws: incompatible dimensions
qty(25, mm).in(meter);             // 0.025
```

**Reactive propagation.** `Source` cells hold inputs; `Derived` cells compute from them and
discover their dependencies automatically as they run, so a dynamic graph works. A change marks
dependents stale; reading recomputes only what is actually observed. Adding a fixture re-sizes
exactly the pipes on its path. Roughly 100 lines, and the reason the whole design is live.

**Rules with traces.** A rule is a pure function of `(inputs, jurisdiction)` returning a value, a
pass flag, and a trace holding the formula, inputs, every intermediate step, the assumptions and
the code clause. The trace is not logging — it is the thing an engineer checks. Rules fail closed:
when nothing in the catalogue satisfies the constraints they return `null` with an explanation,
never a plausible-looking fallback.

```ts
const result = sizeSupplyPipeRule.evaluate({ flow: qty(0.35, lps), medium: 'cold' }, { jurisdiction: GULF_V1 });
result.value;         // 25
result.trace.steps;   // OD20 rejected at 2.507 m/s > 2 m/s; OD25 accepted at 1.604 m/s
```

**Event sourcing.** The model is the fold of an append-only event log, which is where undo, redo,
audit, deterministic replay and jurisdiction switching all come from. The history is transactional
— an event that would leave the model unfoldable is rolled back rather than poisoning the document
— and memoised, so the state folds once per change rather than once per read.

## Jurisdictions are data

Every constant that varies by code lives in a pack: velocity limits, fixture unit tables, concrete
strengths, cable ampacities, duct catalogues. The same event log re-folds under any of them.

```ts
foldLayoutEvents(GULF_V1, events);  // 230 V: a 20 m circuit takes 1.5 mm²
foldLayoutEvents(US_V1, events);    // 120 V: the same circuit takes 2.5 mm²
```

Adding a jurisdiction is a data file, not a fork. Constants that have not been checked against a
published source carry a `VERIFY` marker; see `CONTRIBUTING.md`.

## Running it

```bash
npm test        # 174 tests
npm run typecheck

node examples/villa-branch.ts       # sizing a bathroom branch, with the full trace printed
node examples/reactive-network.ts   # add a fixture and watch the pipe resize itself
```

Node 23.6 or newer. No build step: Node runs the TypeScript directly.

## Testing philosophy

Golden calculations, not smoke tests. Anything numeric is checked against a hand calculation with
the working in a comment, so a refactor cannot quietly change an engineering answer:

- 1 L/s through 100 m of 50 mm at C = 150 loses 0.606 m
- a tee loses exactly three times more through the branch (K = 1.8) than through the run (K = 0.6)
- `Pu = 4300 kN` sizes a 450 mm column under Gulf constants and 500 mm under US

Alongside those: property tests that the propagation graph is genuinely incremental (a diamond
recomputes once, unrelated cells never recompute) and integrity tests that a rejected edit leaves
the document readable.
