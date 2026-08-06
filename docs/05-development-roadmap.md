# 05 — Development Roadmap

> Guiding rule (Doc 00 §8): **every phase is independently valuable and builds on the last. No
> phase waits on a not-yet-built modeler.** The spine (propagation + rules engine + BOQ + AI
> grounding + collab) is built once in Phase 0 and reused by every module thereafter.

## 1. Phases at a glance

| Phase | Theme | Outcome | Rough duration* |
|-------|-------|---------|-----------------|
| **0** | **The Spine** | Foundations; no end-user modules yet | ~3–4 months |
| **1** | **Wedge (v1)** | Plumbing + Electrical + BOQ + Copilot — **first revenue** | ~4–6 months |
| **2** | **Expand core** | HVAC + Structural sizing + Drainage; 2nd jurisdiction | ~4–6 months |
| **3** | **Breadth** | Architecture authoring depth, finishes/interiors, scheduling, procurement | ~6 months |
| **4** | **Lifecycle** | Simulation, FM, low-current, solar, marketplace | ongoing |

\* *Durations assume a small senior team (§4) and are planning estimates, not commitments.*

## 2. Phase detail

### Phase 0 — The Spine (enables everything)
- Monorepo, CI/CD, IaC, environments, observability.
- **Model store:** event-sourced core + CRDT (Yjs) live sync + materialized read model.
- **Propagation engine** (reactive dependency graph) — MVP with a few property types.
- **Rules-engine framework:** Rule interface, units library, jurisdiction/version pinning,
  trace format (no discipline rules yet — just the harness + 2–3 sample rules end-to-end).
- **Geometry/rendering base:** Three.js viewport, web-ifc import, basic snapping/grid/levels,
  simple wall/room sketcher.
- **AI grounding harness:** orchestrator + tool API + the "numbers only from tools" guardrail
  (Doc 06) with one real tool wired.
- **Collab base:** auth, orgs, RBAC, presence, version history.
- **Exit criterion:** an object can be created, edited, propagate a derived quantity, be
  validated by a sample rule with a trace, sync live between two users, and be undone/replayed.

### Phase 1 — Wedge / v1 (first revenue)
- **Plumbing (supply)** + **Electrical (power + lighting)** modules: place, auto-route, edit,
  connect/reconnect.
- **Rules engine v1** (Doc 03) for **one jurisdiction** (MENA/Gulf): pipe sizing/velocity/
  pressure, drainage slope, electrical load/voltage-drop/breaker/cable, lumen-method lighting —
  each backed by golden tests (Doc 07).
- **Live BOQ + cost** with waste factors + editable cost DB.
- **Copilot v1:** propose routing/sizing, explain, flag violations, Q&A grounded in model+rules.
- **Import** IFC/DWG reference; **export** IFC(MEP)/PDF/Excel/glTF.
- **Full manual editability + propagation** on every object.
- **Exit criterion:** hit the Doc 01 §7 success metrics on real projects with design partners.

### Phase 2 — Expand core
- **HVAC** (block-load + duct sizing), **Structural sizing** (beam/column/slab checks),
  **Drainage** (full gravity design). Add **second jurisdiction** (proves the parameterization).
- Design comparison/diff, approval workflows, richer reports (shop/construction drawings).

### Phase 3 — Breadth
- Deeper **architecture authoring**, **finishes/interiors** (ceramic/marble/gypsum/paint with
  takeoff), **scheduling** (link quantities → durations → cash flow), **procurement** basics.

### Phase 4 — Lifecycle & platform
- Engineering **simulation** (flow/pressure/lighting/airflow/construction-sequence),
  **facility management**, **low-current** (fire alarm/CCTV/access), **solar/pools/irrigation**,
  **component/manufacturer marketplace**, public API/plugins.

## 3. Priorities & sequencing logic

1. **De-risk the moat first** — propagation + rules-engine + AI grounding are the hardest and
   most differentiating; prove them in Phase 0 on a thin slice before breadth.
2. **Revenue in Phase 1** — the wedge must be sellable; resist adding modules before paying users.
3. **Prove parameterization early** (2nd jurisdiction in Phase 2) so "global" isn't a myth.
4. **Breadth only on a proven spine** — every later module is "just" new smart objects + rules.

## 4. Team (lean senior team for Phases 0–1)

- **Core product/eng:** 1 architect/CTO, 2–3 senior full-stack (TS), 1–2 3D/graphics eng
  (Three.js/WebGPU/geometry), 1 backend/data eng, 1 AI eng (copilot/RAG/grounding).
- **Engineering domain:** **licensed MEP + structural engineers** (part-time/advisory) to author
  and **verify** rules and golden tests — *non-negotiable for trust/liability (Doc 00 §6)*.
- **Design:** 1 product designer (the CAD-UX is hard).
- **QS/estimator** advisor for the BOQ/cost logic.
- **Later:** QA, DevOps/SRE, more per-discipline engineers as modules expand.

## 5. Top risks & mitigations

| Risk | Impact | Mitigation |
|------|--------|-----------|
| **Scope creep** (the original brief) | Fatal | Wedge discipline; phase gates; "deferred not cancelled" list (Doc 00 §7) |
| **Engineering inaccuracy** | Fatal (liability) | Golden test set + licensed-engineer verification as release gate (Doc 07) |
| **Geometry/perf in browser** | High | Buy kernels; LOD/tiling; WebGPU; server-side heavy compute |
| **AI hallucinated numbers** | High (trust) | Hard guardrail: numbers only from rules tools (Doc 06) |
| **Slow trust/adoption by engineers** | High | Explainability everywhere; design partners; interop with existing tools |
| **Regulatory/jurisdiction sprawl** | Medium | Parameterized rules; one jurisdiction deep before breadth |
| **Talent (3D + domain)** | Medium | Hire senior graphics + engineer-advisors early |

## 6. Release plan

- **Continuous delivery** to staging; **feature-flagged** module rollout.
- **Design-partner alpha** at end of Phase 1 (3–5 friendly MEP firms), tight feedback loop.
- **Private beta** once golden-test + success metrics hold on real projects.
- **GA** per module, per jurisdiction — never ship a discipline/jurisdiction without its golden
  tests green. **Rules are versioned**; projects pin versions so upgrades don't silently change
  a stamped design.

## 7. Definition of done (per module)

Smart-object schema · rules (with traces) · golden tests green · propagation to BOQ/cost ·
import/export coverage · Copilot tool support · Inspector/validation UI · docs · a11y pass ·
perf budget met · security review.
