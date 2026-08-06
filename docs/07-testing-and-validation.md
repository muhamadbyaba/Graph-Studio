# 07 — Testing & Validation Plan

> For most software, tests protect *features*. Here, tests protect *lives and liability*. The
> headline requirement (Doc 00 §6): **no engineering result ships without matching a verified
> reference calculation.** Everything else in this plan is standard rigor; §2 is the one that
> makes or breaks the company.

## 1. Test strategy overview

| Layer | What | Tooling (recommended) |
|-------|------|-----------------------|
| Unit | Pure logic, rules, units, propagation | Vitest (TS), pytest (Py) |
| **Engineering golden** | **Rules vs. verified hand calcs** (§2) | pytest + reference dataset |
| Property-based | Invariants (units, conservation, monotonicity) | fast-check / Hypothesis |
| Integration | Service + DB + event store + CRDT | Testcontainers |
| Contract | API/tool schemas (UI ↔ services ↔ AI tools) | Pact / schema tests |
| E2E | Full user flows in the browser | Playwright |
| **Interoperability** | IFC/DWG round-trip fidelity (§3) | buildingSMART sample suite |
| Performance | Viewport fps, propagation, big models (§4) | k6, Lighthouse, custom viewport bench |
| **AI eval** | Grounding + correctness + safety (§5) | Doc 06 §8 harness |
| Security | AuthZ, tenancy, injection, deps (§6) | ZAP, Semgrep, Snyk, pen test |
| Accessibility | WCAG 2.2 AA + canvas a11y | axe, manual SR testing |

## 2. Engineering accuracy validation — the golden set (highest priority)

**Principle:** every rule (Doc 03) is a release gate keyed to a **golden reference dataset** of
worked calculations whose answers are independently trusted.

- **Sources of truth:** standards' own worked examples (ASHRAE, ACI, IEC, IPC), engineering
  textbooks, and **licensed-engineer hand calcs** commissioned for our cases.
- **Coverage per rule:** nominal case, boundary cases (limits: max velocity, 3%/5% VD, min
  slope, ρ_min/ρ_max), and failure cases (must correctly flag a violation).
- **Exactness:** results must match the reference within a **declared tolerance** (e.g. ±0.5%
  for continuous formulas; **exact** for pass/fail thresholds — a code limit is not "close
  enough").
- **Units:** property-based tests assert unit correctness and that metric/imperial conversions
  round-trip losslessly (the class of bug that sinks engineering tools).
- **Traceability test:** every result must emit a complete trace (formula + inputs + steps +
  clause); a missing/empty trace **fails** the test (explainability is a hard requirement).
- **Jurisdiction matrix:** each rule tested per supported `{jurisdiction, version}`; adding a
  jurisdiction means adding its golden cases, not editing code.
- **Sign-off:** a **licensed engineer of the relevant discipline verifies and signs off** each
  discipline's golden set before GA. Versioned; changes re-verified.
- **Gate:** CI blocks release of any discipline/jurisdiction whose golden set isn't green.

## 3. File compatibility & interoperability

- **IFC round-trip:** import → internal model → export → re-import; assert relevant entities,
  geometry, properties, and system connectivity are preserved (target > 95%, Doc 01 §7). Test
  against **buildingSMART sample files** and real partner models.
- **DWG/DXF:** import fidelity for 2D underlays/reference (layers, units, coordinates). Be
  explicit about proprietary-format limits and use **legally appropriate** libraries/licensing
  (Doc 00 build-vs-buy; no unauthorized proprietary reverse-engineering).
- **Exports:** PDF drawings (correct scale/dimensions/title blocks), Excel/CSV BOQ (numbers tie
  back to model quantities exactly), glTF/GLB (visual fidelity). Golden-file comparison per export.
- **Determinism:** the same model exports byte-stable output where the format allows (diffable).

## 4. Performance & scale

- **Budgets:** viewport **60 fps** on a target model; **propagation < 100 ms** for a typical
  edit's dirty set; BOQ recompute perceptibly instant (optimistic UI, Doc 04 §8).
- **Large-model tests:** 10k / 100k / 1M element synthetic models — assert LOD/tiling keeps
  memory + fps within budget (Doc 02 §8); propagation stays incremental (never O(model)).
- **Load/soak:** concurrent multi-user editing on one project (CRDT sync latency, conflict
  merge correctness); API throughput; async-job queue under batch validation/export.
- **Regression:** perf budgets enforced in CI on representative scenes; alert on regressions.

## 5. AI copilot validation (detail in Doc 06 §8)

- **Grounding test (the critical one):** automated assertion that **no numeric engineering
  claim in any copilot response lacks a tool-result source.** Runs continuously; fail = block.
- **Correctness:** copilot proposals executed against the **golden set** (§2) — sizing/validation
  must match hand calc, same tolerance rules.
- **Safety/red-team:** prompt injection via imported files/comments/manufacturer text; attempts
  to bypass the numeric guardrail; attempts to modify locked/human-authored objects — all must
  **fail closed**. Part of the release gate.
- **Usefulness:** track acceptance/modify/reject rates against targets (Doc 01 §7).
- **Regression suite:** fixed eval battery per release; prompt/model changes gated on it.

## 6. Security testing

- **AuthN/AuthZ:** enforce RBAC + per-project roles at API and field level; **tenant isolation**
  tests (org A can never read org B; row-level security verified with negative tests).
- **SAST/DAST/deps:** Semgrep, ZAP, Snyk/Dependabot in CI; WASM supply-chain pinned & checksummed.
- **Input handling:** malicious/oversized IFC/DWG uploads (parser fuzzing, resource limits);
  the untrusted-data-not-instructions rule for AI ingestion (Doc 06 §6).
- **Data protection:** encryption at rest/in transit verified; signed-URL scoping; audit-log
  immutability (event store append-only, Doc 02 §4).
- **Periodic external penetration test** before GA and on a cadence thereafter.

## 7. Accessibility testing

- Automated **axe** on all non-canvas UI (WCAG 2.2 AA); manual **screen-reader** passes on core
  flows; **keyboard-only** traversal including the **canvas structured-tree parallel** (Doc 04
  §7); contrast, reduced-motion, RTL/Arabic, high-contrast mode.

## 8. CI/CD gates (a release is blocked unless…)

1. Unit + integration + contract green.
2. **Engineering golden set green** for every shipped discipline/jurisdiction (**+ engineer
   sign-off on file**).
3. **AI grounding + safety evals** green.
4. Interop round-trip thresholds met.
5. Performance budgets met (no regressions).
6. Security scans clean (no criticals); a11y checks pass.
7. Feature-flagged rollout + monitoring in place (Doc 05 §6).

## 9. Environments

Local (Testcontainers) → CI (ephemeral) → Staging (prod-like, seeded real-ish models + design
partners) → Production (feature-flagged, observable). Golden + eval suites run in CI **and**
nightly against staging.

## 10. The one-line summary

> If a number could put someone in a building we designed, it does not ship until a verified
> reference calculation — and a licensed engineer — agree with it.
