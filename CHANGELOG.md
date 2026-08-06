# Changelog

All notable changes to this project are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] — 2026-08-07

First public release.

### Engineering core

- Dimensionally safe `Quantity` type: adding incompatible dimensions throws rather than
  producing a plausible wrong number; millimetres and metres round-trip losslessly.
- Reactive propagation graph with automatic dependency tracking. A change marks dependents
  stale; reading recomputes only what is observed, so a diamond dependency recomputes once
  and unrelated cells never recompute at all.
- Pure rule contract `(inputs, jurisdiction) → { value, pass, trace }`. Every result carries
  its formula, inputs, intermediate steps and code clause. Rules fail closed: when nothing in
  the catalogue satisfies the constraints they return `null` with an explanation.
- Jurisdiction packs as data. `GULF` and `US` ship; the same event log re-folds under either.
- Plumbing: Hunter demand, Hazen–Williams friction, velocity checks, PPR sizing; DFU-based
  drainage sizing with Manning self-cleansing velocity; vent sizing; stack-versus-branch
  sizing with branch-interval limits and multi-floor DFU accumulation.
- Hydraulic network solver: residual pressure at every outlet, the critical path, fitting
  minor losses by the K-factor method with run and branch K selected from the drawn turn
  angle, and a computed remedy when the balance fails.
- Hot-water recirculation: loop detection, pump head, and proportional balancing valve sizing
  across multiple return branches.
- Drainage and vent network validation by graph reachability: orphaned drains and unvented
  traps, reported per fixture.
- Electrical: ampacity and voltage-drop cable sizing.
- HVAC: velocity-method round duct sizing.
- Structural: reinforced concrete beams, tied columns with axial load derived from framing
  beam reactions and multi-storey accumulation, and deflection-governed slabs.
- Event-sourced history with undo, redo, audit and deterministic replay. Transactional: an
  event that would leave the model unfoldable is rolled back instead of poisoning the
  document. Memoised: the state folds once per change rather than once per read.
- Referential integrity at the model boundary — a pipe cannot reference a node that does not
  exist, an id cannot be reused, and a non-finite coordinate is refused.
- Bill of quantities aggregation grouped by discipline, with representative unit rates.
- Horizontal section cut of an imported mesh into fitted 2D wall segments.
- 174 tests, including golden hand calculations.

### Studio

- Interactive canvas with three views: a colour schematic, a monochrome CAD double-line sheet,
  and an editable three.js 3D model. Draw, drag, route with bends, split a run to tee into it,
  rotate components, and place from a 132-item component library.
- Live inspector showing the full sizing trace for any element.
- Assisted design: minimum-spanning-tree auto-routing per system, and one-click correction of
  under-slope drains — both emitting ordinary events, so both undo.
- Design copilot grounded by construction: the model receives read-only tools over the engine
  and cannot originate an engineering number. Falls back to deterministic engine answers when
  no API key is configured or the API is unavailable.
- Submittal-quality design report and contractor-ready bill of quantities CSV.
- IFC import: a section cut at a chosen height produces a traceable 2D floor plan, plus a
  coloured 3D reference.
- Accounts with scrypt-hashed passwords, opaque session tokens stored only as digests, and
  workspaces with an owner and an explicit member list.
- Live collaboration over Server-Sent Events, scoped to workspace membership.
- Documents autosave and survive a restart; saved projects store their event log, so reopening
  an old project replays it through today's engine.
- Strict Content-Security-Policy with no `unsafe-inline` for scripts; the two legitimate inline
  scripts are permitted by the hash of their exact contents.
- Request validation at the boundary, output encoding at every sink, spreadsheet
  formula-injection defusing in the CSV export, path containment for static files, per-route
  body ceilings and rate limits.
- 71 tests running against a real server, covering the properties documented in `SECURITY.md`.

[Unreleased]: https://github.com/muhamadbyaba/Graph-Studio/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/muhamadbyaba/Graph-Studio/releases/tag/v0.1.0
