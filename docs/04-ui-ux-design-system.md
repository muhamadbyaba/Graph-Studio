# 04 — UI/UX Design System

> The brief demands "professional CAD behavior" **and** "easier to use than professional
> software." Those pull in opposite directions. The resolution: **CAD-grade precision under the
> hood, progressive disclosure on the surface.** Power is always reachable; it is never the
> first thing a new user sees.

## 1. Design principles

1. **The model is the interface.** The 3D/2D viewport is center stage; panels serve it.
2. **Progressive disclosure.** Beginners see guided flows; experts get keyboard-first CAD.
   Same app, different depth.
3. **Explain in place.** Every calculated number is clickable → shows formula, inputs, code
   clause, assumptions (the rules-engine trace, Doc 03). Trust is a UI feature.
4. **Direct manipulation + precise entry.** Drag *and* type-exact (e.g. type `2500` mm while
   dragging). Never force one or the other.
5. **Non-destructive & reversible.** Everything undoable; AI changes are proposals until accepted.
6. **Show consequences.** Every edit surfaces its ripple: quantities, cost, validation deltas.
7. **Keyboard-first for power users.** Command palette + shortcuts for every frequent action.

## 2. Core layout

```
┌───────────────────────────────────────────────────────────────────────┐
│ Top bar: project · view (2D/3D/split) · discipline filter · presence   │
├──────────┬──────────────────────────────────────────────┬─────────────┤
│ Left     │                                              │ Right        │
│ nav /    │              VIEWPORT (2D / 3D / split)      │ Properties / │
│ system   │        snapping · grids · dimensions ·       │ Inspector    │
│ tree     │        reference planes/levels               │ (smart obj)  │
│ (layers, │                                              │ + validation │
│ levels,  │                                              │ + cost       │
│ systems) │                                              │              │
├──────────┴──────────────────────────────────────────────┴─────────────┤
│ Bottom: live BOQ/cost strip · validation summary · AI Copilot dock     │
└───────────────────────────────────────────────────────────────────────┘
```
- **Left:** hierarchical tree — levels → systems → objects; layer/discipline visibility toggles.
- **Viewport:** 2D plan, 3D, or split-linked. Snapping, grid, reference planes/levels,
  dimensions, alignment/offset tools — professional CAD interaction (§4).
- **Right — Inspector:** the selected smart object's properties, **live validation chips**
  (pass/warn/violation), and its **cost contribution**. Editing here propagates instantly.
- **Bottom:** always-visible **live BOQ + cost total** and **validation rollup**; **Copilot dock**.

## 3. Component library

Built on **design tokens** (see §6) so the whole system is themeable and consistent.

**Primitives:** Button, IconButton, Input (with unit-aware numeric entry), Select, Toggle,
Slider, Tabs, Tooltip, Popover, Modal, Toast, Menu, CommandPalette, Tree, Table (virtualized),
Badge/Chip, ProgressBar, Skeleton.

**Domain components:**
- **Viewport toolbar** — select / move / rotate / scale / route / measure / section.
- **PropertyInspector** — grouped, unit-aware fields; locked/AI-generated indicators.
- **ValidationChip** — pass ✓ / warn ⚠ / violation ✕; click → trace panel.
- **TracePanel** — formula + inputs + steps + clause + assumptions (Doc 03).
- **BOQTable** — virtualized, grouped, each line links back to its object(s).
- **CostStrip** — live total + delta on hover of an edit.
- **CopilotPanel** — chat + inline **proposal cards** (Accept / Modify / Reject / Lock, Doc 06).
- **DiffView** — design/version comparison; highlights changed geometry + quantity/cost deltas.
- **CommentPin** — anchored review comments in 2D/3D.
- **SystemTree** — trace connectivity (e.g., "select this circuit's full path").

## 4. CAD interaction model (precision)

- **Snapping:** endpoint, midpoint, intersection, perpendicular, parallel, tangent, grid, to
  reference plane/level; snap indicators + snap-lock (hold key).
- **Precise input:** type exact dimensions during any drag; tab between value fields; relative
  vs absolute coordinates; real-world CRS.
- **Constraints:** parametric constraints (coincident, parallel, equal, distance) solved by the
  constraint solver (Doc 02); over/under-constrained states flagged.
- **Reference geometry:** planes, levels, grids as first-class; objects can be hosted/aligned to
  them; move the grid → hosted objects follow (propagation).
- **Editing verbs (all objects):** move, rotate, resize, replace, delete, extend, split, merge,
  reconnect (auto-reconnect on move), undo/redo — each triggers propagation.
- **Measure/dimension:** live dimensions, angle, area, clearance checks.

## 5. Key interaction flows

- **Import → validate → price:** drop IFC/DWG → auto-detect rooms/levels → choose discipline →
  Copilot proposes routing → engineer edits → validation + BOQ update live → export.
- **AI proposal:** Copilot posts a **proposal card** (what, why, standards, assumptions, cost Δ,
  alternatives) → engineer Accept / Modify / Reject / Lock → model + BOQ update.
- **Fix a violation:** click a red ValidationChip → TracePanel explains → "Suggest fix" →
  Copilot proposes upsize/reroute with cost impact → accept.

## 6. Design language & tokens

- **Tone:** precise, calm, engineering-professional. High information density done *legibly* —
  clear hierarchy, generous alignment, restrained color used to *mean* something (validation
  status, discipline). Color is semantic, not decorative.
- **Tokens:** color, spacing (4px base grid), typography (a clear UI sans + **monospace/tabular
  figures for all numbers/dimensions** — critical for an engineering tool), radius, elevation,
  motion. Light + dark themes from the same tokens. Per-discipline accent colors
  (plumbing/electrical/HVAC/structural) used consistently across tree, viewport, and BOQ.
- **Implementation:** headless primitives (**Radix**) + tokens (**CSS variables**), styled with
  a utility layer; documented in **Storybook**; charts follow the dataviz palette method.
- **Numbers:** always show units; tabular figures; never lose precision silently (show rounded,
  keep full precision underneath).

## 7. Accessibility (not optional)

- **WCAG 2.2 AA** for all non-canvas UI: keyboard operability, focus management, ARIA, contrast
  ≥ 4.5:1, respects reduced-motion and OS theme.
- **Canvas accessibility** (the hard part): full **keyboard navigation** of the model; a
  screen-reader-friendly **structured outline** (the system tree) as a parallel to the visual
  canvas; announce selection/validation changes; never rely on color alone (icon + text on every
  status chip). Support high-contrast mode.
- **Internationalization + RTL** from the start (Arabic for the MENA/Gulf first market — Doc 00);
  logical properties, locale-aware units/numbers.

## 8. Performance UX

- Viewport at **60 fps** for typical models via LOD/tiling (Doc 02 §8); progressive load with
  skeletons; never block the UI on a heavy calc — validation/BOQ update **optimistically** then
  reconcile.
- Perceived speed: instant local echo (CRDT), background reconcile; explicit "computing…" only
  for genuinely long async jobs.

## 9. Risks

- **Density vs. clarity:** engineering tools drown users in panels. Mitigate with progressive
  disclosure + command palette + strong defaults.
- **Canvas a11y** is genuinely hard; budget real effort — the structured-tree parallel is the key.
- **Two audiences** (novice vs. expert) in one UI: solve with adjustable "depth," not two apps.
