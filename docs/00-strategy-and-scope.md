# 00 — Strategy & Scope

> This is the document that makes the other six buildable. Read it first.

## 1. The core tension in the brief

The brief asks for three things that are each enormous, and asks for them simultaneously:

1. **A from-scratch CAD/BIM modeler** with millimeter precision, parametric constraints,
   snapping, B-rep geometry — i.e. the thing Autodesk, Bentley, and Graphisoft have spent
   *decades* and *billions* building.
2. **~40 engineering modules** (architecture, structural, 8+ MEP disciplines, landscaping,
   interiors, FM, procurement…), each of which is a serious product on its own.
3. **An AI copilot** that designs, validates, estimates, and explains across all of it.

Doing all three at once is not an MVP — it is 5–10 companies. **The failure mode is
predictable: 18 months of building plumbing that never ships because the modeler isn't done,
the modeler never gets done because the geometry kernel is a 5-year problem, and no user ever
touches it.** Every serious BIM startup that tried to "boil the ocean" died this way.

My recommendation is not to shrink the *vision* — it's to sequence it so each phase is
independently valuable and fundable.

## 2. Competitive landscape (honest read)

| Tool | Strength | Where it's weak (our opening) |
|------|----------|-------------------------------|
| **Autodesk Revit** | Industry-standard BIM, huge ecosystem | Desktop, expensive, steep learning curve, poor MEP estimation, code-blind, slow to change |
| **AutoCAD** | Ubiquitous 2D | Not model-based, no engineering intelligence |
| **ArchiCAD (Graphisoft)** | Better UX than Revit, good for architecture | Weak MEP/structural, still desktop |
| **Bentley (OpenBuildings)** | Infrastructure, rigor | Complex, enterprise-only |
| **Tekla (Trimble)** | Best-in-class structural steel/concrete detailing | Narrow, expensive, hard |
| **Procore / Autodesk Build** | Construction management, docs | Not design/engineering; no model authoring |
| **Bluebeam** | PDF markup + takeoff | 2D only, manual |
| **Rhino + Grasshopper** | Parametric geometry, loved by designers | No engineering rules, no estimation, no collaboration model |
| **New cloud/AI entrants** — Snaptrude, Arcol, Hypar, TestFit, Autodesk Forma, Qonic, Motif, Augmenta | Cloud-native, some AI, modern UX | Early; mostly **architecture/massing-focused**; **none owns MEP engineering + estimation + regional codes end-to-end** |

**Conclusion:** the incumbents own *geometry*. The new entrants are fighting over *architectural
massing and design in the browser*. The **wide-open territory is engineering-grade MEP +
structural validation + quantity/cost intelligence, cloud-native, code-aware, AI-explained.**
That is our lane.

## 3. Build vs. Buy — the decisions that de-risk everything

The brief implies building a geometry kernel and IFC support from scratch. **Do not.** These
are solved problems with mature open-source solutions, and building them is where BIM startups
go to die.

| Capability | Decision | Recommended basis |
|------------|----------|-------------------|
| **IFC read/write, BIM object model** | **BUY (open source)** | `web-ifc` / **ThatOpen Components** (formerly IFC.js) — WASM, browser-native, active |
| **B-rep parametric geometry kernel** | **BUY (open source)** | **OpenCascade** via `opencascade.js` (WASM) for solid modeling where needed |
| **3D rendering** | **BUY** | **Three.js** now (WebGL2), migrate hot paths to **WebGPU** as it matures |
| **2D drafting/vector** | **BUY + thin custom layer** | Derive 2D from 3D model + a lightweight vector layer for annotations |
| **Constraint solver (2D sketch)** | **BUY** | `planegcs` (from FreeCAD's geometric constraint solver, WASM) |
| **Parametric dependency propagation** | **BUILD** | Our reactive dependency graph — *this is core IP, not a commodity* |
| **Engineering rules engine** | **BUILD** | Deterministic, jurisdiction-parameterized — **this is the moat** |
| **AI copilot orchestration** | **BUILD on Claude** | Anthropic Claude models via tool-use; grounded in our rules engine |
| **Real-time collaboration** | **BUY pattern** | CRDT (**Yjs**) + event sourcing |

**The principle:** buy the commodity (geometry, rendering, file formats), build the moat
(engineering intelligence, propagation, AI grounding, regional codes, estimation). Every hour
spent reimplementing a geometry kernel is an hour not spent on the thing no competitor has.

## 4. The wedge — where we enter ✅ CONFIRMED

> **Decision (2026-07-20):** wedge = **MEP + BOQ Copilot on imported models**, with a stated
> long-term north star of a **complete BIM platform**. v1 import set is **IFC + DWG/DXF + PDF**
> (PDF caveat below). The full vision is retained as the roadmap's destination (Doc 05); the
> wedge is simply the *first* independently-valuable step toward it — not a smaller ambition.

A wedge must be: (a) a sharp, expensive, frequent pain; (b) valuable *without* first building
a full modeler; (c) a foothold that expands naturally. Three candidates, ranked:

### Confirmed wedge (v1): **"MEP + BOQ Copilot on imported models"**
Ingest an existing architectural model (IFC/DWG) or a simple floor plan, and let the platform:
auto-route/validate **plumbing + electrical**, run engineering checks (pipe sizing, voltage
drop, loads), and produce a **live, itemized Bill of Quantities and cost estimate** that
updates on every edit.
- **Why:** MEP design + takeoff is brutal, manual, error-prone, and done in spreadsheets today.
  Immediate, measurable ROI ("this saved me 3 days and caught a code violation").
- **Doesn't require** building a full architectural modeler first — we *consume* geometry.
- **Expands** into: full MEP authoring → structural → architecture → FM.

### Alternative A: **"Residential/Villa design-to-BOQ"** (vertical wedge)
Full but *narrow* pipeline for **villas/residential** in one region: architecture → auto-MEP →
structural sizing → BOQ → drawings. Deep, not wide. Good if your first customers are
home/villa builders and you control the whole flow.

### Alternative B: **"Estimation/QS copilot"** (pure quantity surveying)
Takeoff + cost intelligence from drawings/models, no authoring. Fastest to revenue, but
thinner moat and crowded (Bluebeam, CostX, Cubicost).

**My recommendation:** the **MEP + BOQ Copilot** wedge, targeting **residential + light
commercial** first. It hits the exact gap the whole market has left open, needs no from-scratch
modeler, and each subsequent module (structural, HVAC, architecture) plugs into the same
rules-engine + BOQ spine.

**On PDF import (added to the v1 set):** PDF is *not* one problem — it's two.
*Vector* PDFs (exported from CAD) carry extractable geometry/text and are tractable. *Raster*
PDFs (scans/photos of drawings) carry pixels only and require **AI vision-based detection** of
walls, rooms, symbols, and dimensions — inherently lossy and needing human confirmation. Plan
PDF import in two tiers: **vector-PDF geometry extraction** in v1; **raster/scanned-PDF
recognition** as an AI feature that always routes through human review (never a silent source of
truth). Treat PDF as a *reference/underlay* input, not an authoritative model, until confirmed.

## 5. Target market / code jurisdiction ✅ CONFIRMED

> **Decision (2026-07-20): first jurisdiction = MENA / Gulf** (e.g., Saudi SBC, Gulf practice,
> IEC-based electrical, IPC-influenced plumbing). Drives the rules library (Doc 03) and the
> golden test set (Doc 07).

Engineering rules are **not universal** — pipe sizing, electrical, and structural codes differ
by country (IPC vs UPC vs local plumbing; NEC vs IEC; ACI vs Eurocode). The rules engine is
**jurisdiction-parameterized from day one**; MENA/Gulf is the *first* set validated deeply,
with IPC/NEC/Eurocode addable later as **data, not code**. **Action item:** identify the exact
adopted codes for the specific target country/emirate (SBC editions, local water-authority and
electricity-authority regulations) — "Gulf" spans several code regimes and the golden set must
cite the precise one.

## 6. The liability reality — non-negotiable

This platform outputs **structural, electrical, and life-safety calculations**. If it sizes a
beam, a breaker, or a drainage stack wrong, the outcome is not a bug ticket — it is collapse,
fire, flooding, and lawsuits. This shapes the product:

- **Positioning:** engineering **decision-support**, not a replacement for a licensed engineer.
  A qualified **Engineer of Record signs off**; the platform accelerates and documents.
- **Traceability:** every number the platform produces must show its **formula, inputs, code
  clause, and assumptions** (this is also the AI-explainability requirement — same mechanism).
- **Validated rule sets:** each rule cites its standard and is verified against worked reference
  cases (Doc 07). Rules are versioned and jurisdiction-tagged.
- **The AI never originates engineering numbers.** It proposes options and explanations; the
  **deterministic rules engine computes and validates.** (Doc 06.)
- **Clear disclaimers + audit log** on every generated deliverable.

## 7. What we are NOT building (at least not first)

To keep the vision honest, these are explicitly **deferred** (not cancelled):
full architectural free-form modeling, structural FEA, CFD-grade HVAC/fluid simulation,
point-cloud/scan-to-BIM, VR, full facility management, procurement/warehouse ERP,
landscaping/irrigation detail. Each returns on the roadmap (Doc 05) once the spine exists.

## 8. Phasing principle

> **Each phase must be independently valuable, sellable, and buildable on the previous one.**
> No phase depends on a not-yet-built modeler. The rules engine + BOQ spine + AI grounding are
> built once and reused by every module. See the roadmap (Doc 05).
