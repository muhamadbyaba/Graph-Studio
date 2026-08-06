# @buildgraph/engineering-core

The **thinnest real vertical slice** proving the Module Framework
([../../docs/08-module-framework.md](../../docs/08-module-framework.md)) and the Plumbing/PPR
reference module ([../../docs/modules/plumbing-ppr.md](../../docs/modules/plumbing-ppr.md)).

It contains the three Engineering-Core pieces every module depends on, plus one discipline's
rules built on top of them:

```
src/
  units/        # dimensionally-safe Quantity + units (mm/m/L·s⁻¹/A/V/…). Numbers never lose their unit.
  rules/        # Rule interface: pure evaluate() -> { value, pass, severity, trace }, + registry
  core/         # reactive propagation graph (signals): incremental, dynamic-dependency recompute
  jurisdiction/ # the Gulf pack — every constant is [VERIFY] data, not hardcoded logic
  plumbing/     # hydraulics (Hazen–Williams, velocity), demand (Hunter), sizing + validation rules
  electrical/   # 2nd discipline reusing the SAME core: voltage drop, ampacity, cable sizing
  model/        # smart objects + connections wired into the propagation graph (PlumbingNetwork)
  boq/          # bill-of-quantities roll-up (discipline-agnostic)
  events/       # event sourcing: append-only log → undo/redo, audit, deterministic replay
  ai/           # copilot tool bus + the "numbers only from tools" guardrail
```

**Why this proves the blueprint:** the rules are pure functions of `(inputs, jurisdiction)` that
return a full **trace** (formula + inputs + steps + clause + assumptions). Swapping the
jurisdiction pack changes the constants without touching a line of rule logic. Electrical/HVAC
reuse the *same* `units` + `rules` + `registry` and only add their own discipline folder.

## Run it (zero install to run)

Node ≥ 23.6 runs the TypeScript directly — no build, no `npm install` needed for tests/examples:

```bash
npm test                          # 47 tests
node --test test/*.test.ts        # same, explicit
node examples/villa-branch.ts     # full explainability trace
node examples/reactive-network.ts # pipe auto-resizes when a fixture is added
```

Optional (dev only) type-checking uses `@types/node` + `typescript`:

```bash
npm install       # dev dependencies only — the runtime needs none
npm run typecheck # tsc --noEmit, strict → clean
```

The suite includes **golden tests** whose expected values are independent hand calculations
(Hazen–Williams head loss, pipe velocity, voltage drop, cable sizing), plus unit-safety,
propagation (incrementality/diamond), event-sourcing (undo/redo/determinism), and AI-guardrail
tests. This is the "no fake numbers" rule made executable (Doc 07 §2).

> Every constant in `jurisdiction/gulf.ts` is a **representative [VERIFY]** value pending
> confirmation against the adopted Gulf code + manufacturer datasheet and a licensed engineer's
> sign-off. The *formulas* are exact.
