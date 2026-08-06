# 02 — Software Architecture

> Principle (from Doc 00): **buy the commodity, build the moat.** Buy geometry, rendering, and
> file formats; build the propagation engine, rules engine, AI grounding, and collaboration model.

> **Implementation note.** This document describes the target architecture for a funded team
> serving many tenants. The reference implementation in this repository deliberately chose a
> smaller shape — one Node process with no runtime dependencies, a browser client with no
> framework, atomic JSON files instead of Postgres — because the thesis it had to prove was the
> engineering one, not the scaling one. The reasoning on both sides, and a concern-by-concern
> reconciliation, is in [`docs/README.md`](README.md#designed-versus-implemented). The sections
> below on the model, the propagation engine, the rules contract and event sourcing (§3–§4)
> describe what was actually built and remain accurate.

## 1. System overview

```
                        ┌──────────────────────────────────────────────┐
                        │                Web Client (SPA)               │
                        │  React + TS · Three.js/WebGPU viewport        │
                        │  web-ifc (WASM) · opencascade.js (WASM)       │
                        │  Yjs (CRDT) local model replica · zustand     │
                        └───────────────┬──────────────────────────────┘
                                        │  WebSocket (sync) / HTTPS (API)
        ┌───────────────────────────────┼───────────────────────────────┐
        │                          API Gateway (BFF)                      │
        │                     TS/NestJS · auth · rate limit               │
        └───┬───────────┬───────────┬───────────┬───────────┬────────────┘
            │           │           │           │           │
   ┌────────▼──┐ ┌──────▼─────┐ ┌───▼────────┐ ┌▼─────────┐ ┌▼───────────┐
   │ Model /   │ │ Rules /    │ │ Estimation │ │ AI       │ │ Collab /   │
   │ Project   │ │ Engineering│ │ / BOQ      │ │ Copilot  │ │ Sync       │
   │ Service   │ │ (Python)   │ │ Service    │ │ (TS orch │ │ (Yjs srv)  │
   │ (TS)      │ │            │ │ (TS/Py)    │ │ +Claude) │ │            │
   └────┬──────┘ └─────┬──────┘ └────┬───────┘ └────┬─────┘ └─────┬──────┘
        │              │             │              │             │
   ┌────▼──────────────▼─────────────▼──────────────▼─────────────▼──────┐
   │  Postgres (JSONB + PostGIS + pgvector) · Event store · Redis · S3    │
   └─────────────────────────────────────────────────────────────────────┘
```

## 2. Technology stack (recommended, with justification)

| Layer | Choice | Why this over alternatives |
|-------|--------|----------------------------|
| **Language (web/API)** | **TypeScript** end-to-end | One language across client/BFF; huge ecosystem; type-safety matters for a data-heavy domain |
| **Frontend framework** | **React 18+** + Vite | Maturity, hiring, ecosystem. (Svelte faster but thinner ecosystem for this scale) |
| **3D rendering** | **Three.js** (react-three-fiber) → **WebGPU** for hot paths | Best-supported browser 3D; WebGPU gives compute for large models when mature |
| **Client state** | **Zustand** + **Yjs** (CRDT for shared model) | Zustand for UI state; Yjs for conflict-free real-time model editing |
| **BIM/IFC** | **web-ifc / ThatOpen Components** (WASM) | Do not build IFC; this is the mature open standard implementation |
| **Geometry kernel** | **opencascade.js** (OCCT, WASM) where B-rep needed; lightweight math otherwise | Real solid modeling without a 5-year kernel project |
| **Constraint solver** | **planegcs** (FreeCAD solver, WASM) | Proven 2D geometric constraints for sketching |
| **API services** | **NestJS** (TS) | Structure, DI, testability for a large service surface |
| **Engineering/rules + AI-adjacent compute** | **Python** (FastAPI) | Engineering/scientific libraries, numeric ecosystem; keep calc logic here |
| **Hot-path compute (later)** | **Rust** (WASM + native) | Introduce *only where profiling demands* — clash detection, big takeoffs |
| **Primary DB** | **PostgreSQL** + JSONB + **PostGIS** + **pgvector** | One battle-tested DB does relational + geo + AI embeddings |
| **Event store** | Postgres append-only tables (or EventStoreDB later) | Event sourcing for versioning/undo/audit (see §4) |
| **Cache / pub-sub** | **Redis** | Sessions, presence, job queues, transient state |
| **Object storage** | **S3-compatible** (AWS S3 / R2) | Large files: IFC, DWG, textures, PDFs, point clouds |
| **Async jobs** | **BullMQ** (Redis) / cloud queue | Long exports, batch validation, AI jobs |
| **AI models** | **Anthropic Claude** (Fable/Opus for reasoning, Haiku for fast/cheap) via tool-use | Strong reasoning + tool use + explainability; grounded, not generative-of-numbers (Doc 06) |
| **Infra** | **Kubernetes** (or Cloud Run / ECS Fargate to start) | Start managed-container-simple; graduate to k8s when scale demands |
| **IaC / CI-CD** | **Terraform** + **GitHub Actions** | Reproducible infra; standard pipelines |
| **Monorepo** | **Turborepo** or **Nx** (pnpm) | Share types/domain between client and services |
| **Observability** | **OpenTelemetry** + Grafana/Loki/Tempo; **Sentry** | Traces across the polyglot mesh |

**Why polyglot (TS + Python + later Rust)?** The domains have different centers of gravity: TS
for product/UI/API cohesion, Python for engineering/scientific calculation and AI tooling, Rust
only where raw performance is proven necessary. Boundaries are clean service APIs, so this is
manageable — but we start with just **TS + Python** to avoid premature complexity.

## 3. The three engines that are our IP

### 3.1 Parametric dependency / propagation engine (BUILD)
The heart of "every change updates every connected system." Model it as a **directed acyclic
dependency graph** of *computed properties*:

- Each smart object exposes **inputs** (geometry, material, parameters) and **derived outputs**
  (length, load, flow demand, cost).
- Derived outputs declare their **dependencies** on other objects' properties (e.g., a pipe
  segment's flow depends on downstream fixtures; a panel's load depends on its circuits).
- On edit, compute the **dirty set** via reverse dependency edges and **recompute only what
  changed**, topologically ordered. Detect cycles (e.g., mutually dependent constraints) and
  resolve via the constraint solver or flag them.
- This is *reactive computation* over a domain graph — think "spreadsheet recalculation, but the
  cells are engineering properties." It must be incremental (never recompute the whole model)
  and deterministic.

### 3.2 Engineering rules engine (BUILD) — the moat
Deterministic, **jurisdiction-parameterized**, fully traceable. See Doc 03 for the rules. Design:

- A **Rule** = `{ id, discipline, jurisdiction, version, inputs, formula, code_clause,
  assumptions, evaluate(inputs) -> {value, unit, pass/fail, explanation, trace} }`.
- Rules are **pure functions** with **units enforced** (a units library — never bare floats;
  mm vs m vs in errors kill people and projects). Every result returns a **trace**: formula,
  inputs, intermediate values, clause, assumptions. That trace *is* the explainability and the
  liability record.
- Rules are **versioned and jurisdiction-tagged**; the project pins a jurisdiction + version.
- Runs on the Python service; called by propagation (auto) and by the copilot (on demand).

### 3.3 AI grounding harness (BUILD) — see Doc 06
The copilot never computes engineering numbers itself. It calls **tools** that hit the rules
engine and the model API; the deterministic results flow back into its explanations. The AI's
job is search, proposal, comparison, and natural-language explanation — grounded in tool output.

## 4. Data model & persistence

### 4.1 Model representation — event-sourced + CRDT
BIM edits demand: full version history, undo/redo, audit, and real-time multi-user merge.
The natural fit:

- **Event sourcing:** the project model is the fold of an **append-only event log**
  (`ObjectCreated`, `PropertyChanged`, `ObjectConnected`, `ObjectDeleted`…). This gives
  version history, time-travel, audit, and change tracking *for free* — all brief requirements.
- **CRDT (Yjs)** for the **live, in-session** shared document so concurrent edits merge without
  conflicts; periodically **checkpoint** CRDT state and emit domain events to the event store.
- **Materialized read model** (current-state) in Postgres JSONB + PostGIS for fast queries,
  rebuilt/derived from events.

### 4.2 Smart object schema (illustrative)
```jsonc
{
  "id": "pipe-7f3a...",
  "type": "PipeSegment",
  "discipline": "plumbing.supply",
  "geometry": { "kind": "polyline3d", "points": [...], "diameter_mm": 25, "crs": "project" },
  "material": { "spec": "PPR PN20", "manufacturer": "…", "roughness_C": 150 },
  "engineering": {                      // derived + validated by rules engine
    "flow_lps": 0.63, "velocity_ms": 1.28, "headloss_m": 0.41,
    "checks": [ { "rule": "velocity_limit@GULF/v1", "pass": true, "trace": "…" } ]
  },
  "cost": { "unit": "m", "qty": 4.20, "material_cost": 12.6, "labor_cost": 8.4, "waste_pct": 5 },
  "connections": ["fitting-91c...", "fixture-22b..."],   // graph edges
  "dependencies": { "flow": ["fixture-22b...", "fixture-33d..."] },
  "lifecycle": { "install": "solvent-weld", "life_years": 50, "maintenance": "…" },
  "meta": { "created_by": "...", "locked": false, "ai_generated": true, "version": 42 }
}
```
- **Connections + dependencies are first-class graph edges** — they drive propagation (§3.1),
  clash detection, and system tracing (e.g., "trace this circuit back to the panel").
- **`locked` / `ai_generated`** honor the brief's control requirements (accept/reject/lock/override).

### 4.3 Storage layout
- **Postgres**: projects, materialized model state (JSONB), spatial index (PostGIS), users,
  orgs, permissions, cost DB, rule catalog, embeddings (pgvector for RAG over codes/specs).
- **Event store**: append-only event tables per project (partitioned).
- **S3**: source IFC/DWG uploads, exported deliverables, textures, large binaries.
- **Redis**: presence, locks, job queues, ephemeral CRDT awareness.

## 5. API design

- **GraphQL** for the rich, nested, client-driven model reads (a BIM model is a deep graph;
  GraphQL avoids N REST round-trips and lets the viewport fetch exactly what it needs).
- **REST** for simple CRUD, file upload/download, exports, webhooks.
- **WebSocket** (Yjs provider) for real-time model sync + presence.
- **Tool API** (internal) — the typed function surface the AI copilot calls (Doc 06). Same
  contracts the UI uses, so AI actions are exactly as validated as human actions.
- **Versioned, contract-tested** (Doc 07). Domain types shared via the monorepo.

## 6. AI services architecture (summary; detail in Doc 06)

- **Orchestrator** (TS): receives a copilot request + model context, plans tool calls, calls
  Claude with the **tool schema**, executes tools (model queries, rules-engine calls, cost
  lookups, RAG retrieval over codes), loops until done, returns a **proposal + explanation +
  trace**.
- **RAG store:** codes/standards, manufacturer specs, and project docs embedded in **pgvector**;
  retrieval grounds explanations and citations.
- **Guardrail:** the orchestrator **rejects any AI-asserted numeric engineering value that did
  not come from a rules-engine tool result.** Numbers come from tools, prose comes from the LLM.

## 7. Security architecture (detail in Doc 07 §security)

- **AuthN:** OIDC/OAuth2 (SSO for enterprise), short-lived JWT + refresh, WebAuthn/MFA option.
- **AuthZ:** RBAC + per-project roles (owner/editor/reviewer/viewer) enforced at the API and
  the field level; the CRDT server authorizes every mutation.
- **Tenancy:** row-level security in Postgres (org_id scoping); per-tenant S3 prefixes.
- **Data:** encryption at rest (KMS) + TLS in transit; signed URLs for S3.
- **Audit:** the event log *is* the audit trail; immutable, queryable.
- **AI safety:** tool-scoped permissions (the AI can propose but destructive actions need human
  confirm); prompt-injection defense on ingested files/comments; no training on customer data
  without consent.

## 8. Scalability & performance

- **Large models** (100k+ elements): server-side spatial tiling + LOD streaming to the viewport;
  the client holds a windowed subset, not the whole model. Instanced rendering + WebGPU compute.
- **Propagation** stays incremental (dirty-set only) — never O(model) per edit.
- **Heavy jobs** (full validation, big exports, clash detection) run async on the queue; results
  stream back. Move to **Rust** if/when Python/TS become the bottleneck (profile first).
- **Stateless services** behind autoscaling; the CRDT/sync layer is the main stateful tier —
  shard by project; sticky sessions per project room.
- **Cost control on AI:** cache retrievals + tool results; route simple asks to **Haiku**,
  hard reasoning to **Opus/Fable**; stream responses.

## 9. Key architectural risks

| Risk | Mitigation |
|------|------------|
| Geometry-kernel-in-browser performance at scale | LOD/tiling; WebGPU; keep heavy geometry server-side |
| Propagation graph cycles / runaway recompute | Cycle detection, dirty-set incrementality, budgets, timeouts |
| Polyglot complexity | Start TS+Python only; clean service contracts; shared types |
| CRDT + event-sourcing consistency | Checkpoint discipline; events as source of truth; rebuild tests |
| IFC round-trip fidelity | Conformance test suite vs. buildingSMART samples (Doc 07) |
| AI hallucinated numbers | Hard guardrail: numbers only from rules-engine tools (§6) |
