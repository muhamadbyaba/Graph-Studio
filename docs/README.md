# Documentation

Two kinds of document live here, and it matters which you are reading.

**Design documents** (`00`–`08`) were written before the code, to decide what to build and
what not to build. They still describe the intent, the engineering approach and the module
contract accurately. Where they propose a *technology stack*, they propose the one a funded
team would reach for — and the reference implementation deliberately chose differently. That
divergence is explained below rather than quietly corrected, because the reasoning on both
sides is worth keeping.

**Implementation documents** describe what actually exists and how to run it.

## Index

| Document | What it covers |
| --- | --- |
| [00 — Strategy and scope](00-strategy-and-scope.md) | Why a from-scratch BIM modeller is the wrong first move, and what the wedge is instead. Read this first. |
| [01 — Vision and PRD](01-vision-and-prd.md) | The product: who it is for, what it must do, what success looks like. |
| [02 — Architecture](02-architecture.md) | The target architecture at scale, and the reasoning behind each layer. |
| [03 — Engineering rules library](03-engineering-rules-library.md) | How rules, traces and jurisdiction packs are specified. |
| [04 — UI and UX design system](04-ui-ux-design-system.md) | Interaction model, canvas behaviour, visual language. |
| [05 — Development roadmap](05-development-roadmap.md) | Phasing, and what each phase must prove before the next starts. |
| [06 — AI copilot specification](06-ai-copilot-spec.md) | The grounding contract: why the model may never originate a number. |
| [07 — Testing and validation](07-testing-and-validation.md) | Golden reference calculations as a release gate. |
| [08 — Module framework](08-module-framework.md) | The module contract every discipline fills. **The most important document if you want to add a discipline.** |
| [modules/plumbing-ppr](modules/plumbing-ppr.md) | The worked reference module. Copy its shape. |
| [Deployment](DEPLOYMENT.md) | Running it in production. |
| [`SECURITY.md`](../SECURITY.md) | The security model, in full. |
| [`CONTRIBUTING.md`](../CONTRIBUTING.md) | What the codebase expects of a change. |

## Designed versus implemented

The design documents describe a distributed system: a React client with a CRDT replica, a
NestJS gateway, Python engineering services, Postgres with an event store, Redis and object
storage. That is a reasonable target for a funded team serving many tenants.

The reference implementation is a Node process with no runtime dependencies and a browser
client with no framework. This is not the design document being ignored; it is a different
answer to a different question. The design assumed a team and a funding round. The
implementation had to prove the *engineering* thesis — that a reactive propagation graph over
deterministic, jurisdiction-parameterised rules produces a live, auditable design — and every
layer that did not serve that proof was cut.

| Concern | Designed | Implemented | Why |
| --- | --- | --- | --- |
| Client | React + Zustand + Vite | Vanilla JS, ES modules, no build | The canvas is SVG and three.js. A framework would have added a build step and a dependency tree without changing a line of drawing logic. |
| Model sync | Yjs CRDT | Event log + state broadcast over SSE | A CRDT is the right answer for concurrent editing of the same element. Nothing shipped yet needs it, and it is a large dependency to carry speculatively. Recorded as a known limit in `SECURITY.md`. |
| API layer | NestJS | ~600 lines of Node `http` with an explicit pipeline | At this route count the framework's structure costs more than it saves, and an explicit pipeline is far easier to audit for the security properties that matter here. |
| Engineering compute | Python (FastAPI) service | TypeScript in-process | Splitting the calculation into another language and another process would have bought scientific libraries this domain does not need, at the cost of the type safety that catches unit errors and a network hop in the middle of a reactive graph. |
| Persistence | Postgres + Redis + S3 | Atomic JSON files | Right for single-instance self-hosting, which is what this targets. The store interfaces are narrow enough that a database swap touches three files. |
| Geometry kernel | opencascade.js | Purpose-built section-cut maths | Only one geometric operation is needed so far: intersecting a mesh with a horizontal plane. That is 90 lines and fully tested. |

Where the design documents and the code disagree about *engineering* — a formula, a rule
contract, a trace requirement — the code is authoritative and the document is a bug. Where
they disagree about *infrastructure*, the table above is the reconciliation.

## The parts that did survive intact

Everything load-bearing:

- **The prime directive** from `08`: a new capability strengthens the shared core rather than
  forking it. Four disciplines share one propagation graph, one rules registry, one event log
  and one quantity aggregator.
- **The rule contract** from `03`: `(inputs, jurisdiction) → { value, pass, trace }`, pure, with
  the working shown and failure closed.
- **Jurisdiction as data** from `00`: constants live in swappable packs, and the same event log
  re-folds under any of them.
- **The grounding contract** from `06`: the AI never originates an engineering number. It is
  given read-only tools over the engine, which makes this a structural property rather than a
  request in a prompt.
- **Golden calculations as a release gate** from `07`.
