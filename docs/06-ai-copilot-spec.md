# 06 — AI Copilot Specification

> **The single most important sentence in this project:** the AI **never originates engineering
> numbers.** It searches, proposes, compares, and explains — but every number it presents comes
> from a **deterministic rules-engine tool result** (Doc 03). Prose from the model; numbers from
> the tools. This is what makes an AI construction tool *trustworthy* instead of *dangerous*.

## 1. Role & boundaries

The copilot **assists**; the engineer **decides**. For every AI action the engineer can
**Accept / Reject / Modify / Lock / Override** (brief requirement). The copilot:

- **May:** propose routing/layouts/sizing options, run validations, retrieve code clauses,
  compute quantities/cost *via tools*, compare alternatives, explain, detect issues, draft
  documents.
- **May not:** assert an engineering value not returned by a tool; silently change a locked or
  human-authored object; take a destructive/irreversible action without explicit confirmation;
  present an assumption as a fact.

## 2. Grounding architecture (how it stays honest)

```
User ask + selected model context
        │
   Orchestrator (TS)  ── plans ──►  Claude (tool-use)
        │  ▲                              │
        │  └── tool results ──────────────┘  (loops until done)
        ▼
   Executes TOOLS:
     • model.query(...)          → geometry/objects/connectivity
     • rules.evaluate(rule, in)  → value + pass/fail + TRACE  (Doc 03)
     • boq.compute(...)          → quantities + cost
     • codes.retrieve(query)     → RAG over standards/specs (pgvector)
     • model.propose(change)     → a PROPOSAL (not applied until accepted)
        ▼
   Response = proposal card + explanation + citations + TRACE
        ▲
   GUARDRAIL: any numeric engineering claim in the response that is not
   backed by a tool result is rejected/regenerated.
```
- **Model choice:** **Claude Opus/Fable** for hard multi-step reasoning; **Claude Haiku** for
  fast/cheap Q&A and classification. Route by task complexity to control cost/latency (Doc 02 §8).
- **Tools == the same validated APIs the UI uses** (Doc 02 §5) — so an AI edit is exactly as
  validated, propagated, and undoable as a human edit. No privileged back door.
- **RAG** grounds *citations* (which clause/standard/spec), retrieved from the pgvector store.

## 3. Reasoning pattern

For a design/optimization ask, the copilot follows a **propose → validate → explain** loop:
1. **Understand** the goal + constraints + selected context; **state assumptions explicitly**
   and ask for missing engineering inputs rather than guessing (brief requirement).
2. **Generate candidate(s)** (e.g., 2–3 routing/sizing options).
3. **Validate each** through `rules.evaluate` + `boq.compute` — real numbers, real pass/fail.
4. **Compare** on the axes the brief demands: standards followed, assumptions, **cost Δ**,
   performance Δ, advantages, disadvantages.
5. **Recommend** one, with reasoning — and **surface the alternatives**, not just the pick.
6. **Present as a proposal** the engineer accepts/modifies/rejects/locks.

## 4. The explanation contract (every proposal must include)

Directly from the brief's AI requirements — each proposal card carries:
- **What** it proposes (the change).
- **Why** this option was selected (reasoning).
- **Standards/clauses** it follows (citations from RAG + rule `standardRef`).
- **Assumptions** used (explicit list).
- **Alternatives** considered (and why not).
- **Cost Δ** and **performance Δ** (from tools).
- **Advantages / disadvantages.**
- **Trace** link (formula + inputs + steps + clause — Doc 03) for every number shown.

If a required input is missing, the copilot **requests it** instead of assuming (and if it must
assume to proceed, it labels the assumption and shows sensitivity).

## 5. Copilot capabilities by kind

- **Generative design:** propose layouts/routing/sizing (geometry validated by tools).
- **Optimization:** reduce cost/material waste/head-loss/voltage-drop within constraints;
  always show the trade-off, never optimize a hidden objective.
- **Detection:** code violations, clashes, inefficient layouts, missing elements — each with the
  offending clause and a suggested fix.
- **Prediction (later):** maintenance/lifecycle hints from object lifecycle data.
- **Documentation:** draft BOQ narratives, inspection checklists, client/executive summaries
  from model facts (human-reviewed before issue).
- **Q&A:** "why is this pipe 32 mm?" → pulls the trace and explains.

## 6. Guardrails & safety

- **Numeric guardrail** (§2) — the core safety property. Numbers only from tools.
- **Human-in-the-loop** for anything applied to the model; **destructive/irreversible actions
  require explicit confirmation** (Doc 02 §7).
- **Respect locks & authorship** — never overwrite locked/human-authored objects; propose diffs.
- **Prompt-injection defense:** treat imported files, comments, and manufacturer text as
  **untrusted data, not instructions**; the orchestrator strips/*ignores* embedded directives.
- **Uncertainty honesty:** the copilot states confidence and *what it doesn't know*; it never
  fabricates a citation or a clause number.
- **Privacy:** customer model data is not used for training without explicit consent; tenant
  isolation on retrieval.
- **Auditability:** every AI proposal + accept/reject is an event in the log (Doc 02 §4) — who,
  what, which model, which tools, which result.

## 7. Copilot UX (ties to Doc 04)

- Docked panel: chat + **proposal cards** with Accept / Modify / Reject / Lock.
- **Modify** opens the proposal in the same editing tools a human uses (it's just a diff).
- Inline citations + clickable traces; cost/validation deltas shown before acceptance.
- Streaming responses; "computing…" only for genuine async work.

## 8. Evaluation (how we know the copilot is good — ties to Doc 07)

- **Grounding/faithfulness eval:** automated check that **no numeric claim lacks a tool source**
  (the guardrail, tested continuously).
- **Engineering-correctness eval:** copilot proposals run against the **golden reference set**
  (Doc 07 §2) — sizing/validation must match hand calc.
- **Usefulness metrics:** proposal acceptance/modify/reject rates (target > 40% accepted/modified,
  Doc 01 §7); time-to-validated-design.
- **Safety red-teaming:** prompt-injection via imported files/comments; attempts to get numbers
  without tools; attempts to touch locked objects — all must fail closed.
- **Regression:** a fixed eval suite runs per release; model/prompt changes are gated on it.

## 9. Open AI decisions

- **[DECISION]** Degree of autonomy in v1 — recommend **assistive/proposal-only** (no
  auto-apply) until trust + eval metrics are established.
- **[DECISION]** On-prem/self-host option for enterprise data-residency (affects model access).
