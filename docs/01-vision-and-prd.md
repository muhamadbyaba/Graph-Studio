# 01 — Vision & Product Requirements (PRD)

## 1. Vision

Build the **engineering intelligence layer** for construction: a cloud-first platform where
every building element is a smart engineering object, every change propagates through every
connected system, every calculation is engineering-grade and traceable, and an AI copilot
accelerates the engineer without ever taking the pen out of their hand.

**Positioning statement:** *For engineers and design-build firms who are drowning in manual
MEP design, takeoff, and code-checking, BuildGraph is a cloud BIM platform that automatically
routes, validates, and prices building systems and explains every decision — unlike Revit +
spreadsheets, it is browser-based, real-time collaborative, code-aware, and AI-assisted.*

## 2. Who it's for (personas)

| Persona | Goal | Today's pain | What we give them |
|---------|------|--------------|-------------------|
| **MEP Engineer (primary)** | Route + size + validate + document building systems | Manual routing in Revit/AutoCAD, sizing in spreadsheets, code-checking by hand | Auto-route + instant validation + live BOQ + explainable AI |
| **Quantity Surveyor / Estimator** | Accurate BOQ & cost from the design | Manual takeoff, stale the moment design changes | Live BOQ that updates on every edit, waste factors, cost DB |
| **Structural Engineer** | Size members, check loads | Separate tools, re-entry of data | Integrated loads from the same model |
| **Architect / Design-build lead** | Coordinate a buildable, priced design | Silos between arch/MEP/structural/cost | One model, one source of truth |
| **Project Manager / Owner** | Cost certainty, progress, decisions | Reports lag reality | Live cost/schedule dashboards, executive reports |
| **Reviewer / Approver** | Verify compliance | Chasing versions | Versioned model, comments, approvals, audit log |

**Primary persona for v1:** the **MEP Engineer** (per the wedge in Doc 00).

## 3. Jobs to be done (top of the list)

1. "Turn this floor plan / IFC into a **validated, priced** MEP design in hours, not days."
2. "Tell me **instantly** if I've violated a code — and *which clause*."
3. "Keep my **BOQ and cost** correct automatically as the design changes."
4. "**Explain** why this pipe/cable/duct size — I need to defend it to a reviewer."
5. "Let my team **work on the same model at once** without emailing files."
6. "Produce **drawings, BOQ, and reports** I can hand to a contractor or client."

## 4. Product pillars

1. **Smart objects** — every element carries geometry + engineering properties + material +
   cost + connections + dependencies + lifecycle data (see data model, Doc 02).
2. **Propagation** — change one thing; every dependent quantity, calc, and cost updates.
3. **Deterministic engineering** — a jurisdiction-aware rules engine; no guessing, no fake
   numbers, every result traceable to a formula and a code clause (Doc 03).
4. **Explainable AI copilot** — proposes, compares, and explains; never the source of truth
   for numbers (Doc 06).
5. **Cloud-native collaboration** — real-time multi-user, versioned, audited (Doc 02).
6. **Interoperability** — IFC/DWG/DXF in, IFC/PDF/Excel/glTF out (Doc 07 §file compat).

## 5. MVP scope (v1 — the wedge)

**In:**
- Import: **IFC** (rooms/spaces/walls as reference), **DWG/DXF** (2D underlay), **PDF**
  (vector-PDF geometry in v1; raster/scanned via AI vision behind human review — see Doc 00 §4),
  plus a simple built-in floor-plan sketcher (walls, rooms, levels) with mm precision + snapping
  + grids.
- **Plumbing (water supply) + Electrical (power + lighting)** modules: place fixtures,
  auto-route + manual edit, size, validate.
- **Rules engine v1:** pipe sizing (Hazen-Williams/fixture units), water velocity/pressure
  checks, drainage slope, electrical load, voltage drop, breaker & cable sizing, lighting
  level (lumen method) — for **one jurisdiction** (Doc 00 §5).
- **Live BOQ + cost estimate** with waste factors and an editable cost database.
- **AI copilot:** propose routing/sizing, explain decisions, flag violations, answer
  "what/why" questions grounded in the model + rules.
- **Collaboration:** multi-user real-time editing, comments, version history, roles.
- **Export:** IFC (MEP systems), PDF drawings, Excel/CSV BOQ, glTF 3D view.
- **Manual editability of every object** (move/rotate/resize/split/merge/reconnect/undo/redo)
  with propagation — this is a hard requirement, not a nice-to-have.

**Out (deferred to later phases):** structural design, HVAC/duct design, drainage full
simulation, fire alarm/CCTV/access control, solar, pools, landscaping, interiors/finishes
detail, FM, procurement/warehouse, scheduling. (Roadmap, Doc 05.)

## 6. Non-goals (v1)

- Not a general-purpose CAD/free-form modeler.
- Not a replacement for the Engineer of Record (Doc 00 §6).
- Not FEA/CFD-grade physics simulation.
- Not offline-desktop.

## 7. Success metrics

| Metric | Target (v1) | Why |
|--------|-------------|-----|
| Time to first validated MEP + BOQ from an imported plan | **< 2 hours** (vs. days) | Core value prop |
| Sizing/validation accuracy vs. hand calc on reference cases | **100% match** on the golden set (Doc 07) | Trust / liability |
| % of engineer edits that auto-propagate correctly to BOQ | **100%** | Core promise |
| AI suggestion acceptance rate | **> 40%** accepted/modified (vs. rejected) | Copilot usefulness |
| Weekly active engineers per paying account | trend up | Stickiness |
| Import fidelity (IFC round-trip) | **> 95%** of relevant entities preserved | Interop credibility |

## 8. Roadmap themes (detail in Doc 05)

- **Phase 0 — Spine:** model store, propagation engine, rules-engine framework, collab, AI
  grounding harness. (No user-facing modules yet; enables everything.)
- **Phase 1 — Wedge (v1):** Plumbing + Electrical + BOQ + Copilot. *First revenue.*
- **Phase 2:** HVAC + Structural sizing + Drainage; more jurisdictions.
- **Phase 3:** Architecture authoring depth, finishes/interiors, scheduling, procurement.
- **Phase 4:** Simulation, FM/lifecycle, low-current systems, solar, marketplace.

## 9. Product decisions

- ✅ **Wedge:** MEP + BOQ Copilot on imported models (Doc 00 §4) — *confirmed 2026-07-20*.
- ✅ **First jurisdiction:** MENA/Gulf (Doc 00 §5) — *confirmed 2026-07-20*. **Action:** pin the
  exact adopted codes for the target country.
- **[DECISION — open]** Pricing model — seat-based SaaS vs. project-based vs. usage (AI) hybrid.
  *Recommendation:* per-seat SaaS + metered AI, with a project cap on lower tiers.
- **[DECISION — open]** Self-serve vs. sales-led GTM for first customers.
