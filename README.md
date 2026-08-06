<div align="center">

# BuildGraph

**An engineering intelligence platform for building services.**

Draw a building's systems and the engineering follows every change — sizes, code checks,
pressure balance, structural design and a priced bill of quantities, recomputed live, with
the working shown for every number.

[![CI](https://github.com/muhamadbyaba/Graph-Studio/actions/workflows/ci.yml/badge.svg)](https://github.com/muhamadbyaba/Graph-Studio/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A523.6-339933.svg)](https://nodejs.org)
[![Runtime dependencies](https://img.shields.io/badge/runtime%20dependencies-0-success.svg)](#why-zero-dependencies)
[![Tests](https://img.shields.io/badge/tests-245-success.svg)](#testing)

![The design canvas: a villa's cold supply, drainage, vent, power and duct systems on one plan, with the selected pipe's full sizing trace in the inspector](docs/images/studio-schematic.png)

</div>

---

## The problem

Drawing tools draw. They do not know that moving a fixture three metres changes the demand
on the pipe feeding it, that the pipe is now undersized, that the residual pressure at the
furthest outlet has dropped below the code minimum, and that the bill of quantities is out
of date.

So an MEP engineer draws in one tool, sizes in a spreadsheet, checks against a code PDF, and
takes off quantities by hand. The three artefacts disagree the moment anything moves, and
the reconciliation is manual, repeated on every revision, and where the errors live.

BuildGraph closes that loop. The drawing *is* the model. Every edit propagates through a
deterministic rules engine, and the sizes, the compliance register and the priced take-off
are all views of the same live state.

## What it does

**Four disciplines on one canvas.** Plumbing (cold, hot, drainage, vent), electrical, HVAC
and reinforced concrete — seven media in total, each a tree rooted at its own source: tank,
sewer outlet, roof vent terminal, distribution board, air handling unit.

**Everything sizes itself, and shows its work.** Hunter demand and Hazen–Williams for supply;
DFU tables and Manning self-cleansing velocity for drainage; ampacity plus voltage drop for
cables; the velocity method for ducts; ACI-style flexure and axial design for beams, columns
and slabs. Select any element and the inspector shows the formula, the inputs, each step, the
sizes that were rejected and why, and the clause it answers to.

**A hydraulic network solver, not per-pipe sizing.** Most tools size each pipe in isolation.
BuildGraph solves the whole supply tree: residual pressure at every outlet, the critical path
that governs it, Hazen–Williams friction plus fitting minor losses by the K-factor method —
where a tee takes branch or run K depending on the actual turn angle in your drawing. When it
fails, it computes the fix: the exact supply pressure that clears it, or the specific pipes to
upsize, applied as ordinary edits you can undo.

**Code as data, not code.** Every jurisdiction-dependent constant lives in a swappable pack.
Switch from Gulf practice to US and the same event log re-folds under different constants: a
20 m circuit that needed 1.5 mm² at 230 V comes back as 2.5 mm² at 120 V, from the same
drawing, with no migration. Adding a jurisdiction is a data file, not a fork.

**Deliverables an engineer can hand over.** A submittal-quality design report — cover, cost
summary by discipline, code compliance register, per-discipline schedules, structural design,
fixture schedule, priced bill of quantities, and an explicit Engineer-of-Record disclaimer.
Plus the bill of quantities as a contractor-ready CSV.

**A design copilot that cannot make numbers up.** Ask "what fails?", "why this size?", "what
does this cost?" in plain language. The model is given read-only tools over the engine and a
prompt that forbids inventing figures — so every quantity it states was computed by the rules
engine, not generated. With no API key configured it still answers, deterministically, from
the same engine.

**Live collaboration.** Workspaces with an owner and invited members; edits stream to every
collaborator over Server-Sent Events as they happen.

**Import what exists.** Drop an IFC model and it is section-cut at a chosen height into a real
2D floor plan you can trace your services over — a horizontal slice through the geometry, not
a projection.

## Try it

```bash
git clone https://github.com/muhamadbyaba/Graph-Studio.git
cd Graph-Studio
npm install
npm start
```

Then open <http://127.0.0.1:4317> and create an account.

To skip the sign-in while you look around:

```bash
BG_AUTH_MODE=open npm start
```

That mode refuses to start on anything but loopback, so it cannot be exposed by accident.

**Requires Node 23.6 or newer.** There is no build step — Node runs the TypeScript directly.

### A two-minute tour

1. Click **Tank / Source** in the palette, then click the canvas. Do the same for a couple of
   fixtures.
2. Press **P**, click two components to connect them. Sizes, velocities and head losses appear
   immediately; the bill of quantities prices itself on the right.
3. Drag a fixture. Watch the pipe length, the head loss, the pressure balance and the cost all
   follow.
4. Hit **🌡 Pressure**. The critical path lights up and every outlet is tagged with its residual.
   Drop the supply pressure in the panel until something turns red, then use the auto-fix.
5. Switch the jurisdiction dropdown from `GULF` to `US` and watch the design re-validate.
6. Hit **🖨 Report** for the full design document.

## What it looks like

<table>
<tr>
<td width="50%"><img src="docs/images/studio-pressure.png" alt="The pressure map: the critical path highlighted and every outlet tagged with its residual pressure"></td>
<td width="50%"><img src="docs/images/studio-cad.png" alt="The CAD view: monochrome double-line pipework with dashed centrelines, like a coordination sheet"></td>
</tr>
<tr>
<td><b>Pressure map.</b> The governing path lights up and every outlet carries its residual pressure. Drop the supply and watch which fixture fails first.</td>
<td><b>CAD sheet.</b> The same model as double-line monochrome pipework — the drawing an engineer would actually issue.</td>
</tr>
<tr>
<td><img src="docs/images/studio-3d.png" alt="The 3D view: pipes, ducts, cables and structural members routed in three dimensions"></td>
<td><img src="docs/images/report.png" alt="The generated design report: cover with KPIs, cost summary by discipline, compliance register and per-discipline schedules"></td>
</tr>
<tr>
<td><b>3D model.</b> Editable, not just a preview — click to select, drag to move, and the plan follows.</td>
<td><b>Design report.</b> Generated from the model: compliance register, per-discipline schedules, priced bill of quantities, Engineer-of-Record disclaimer.</td>
</tr>
</table>

## How it works

```
┌─────────────────────────────────────────────────────────────────────┐
│  Browser — SVG canvas · CAD view · three.js 3D · no framework       │
└───────────────────────────────┬─────────────────────────────────────┘
                    LayoutEvents │ ▲ state snapshots (also pushed by SSE)
                                 ▼ │
┌─────────────────────────────────────────────────────────────────────┐
│  apps/studio — HTTP server: sessions, workspaces, validation,       │
│  persistence, deliverables. No engineering happens here.            │
└───────────────────────────────┬─────────────────────────────────────┘
                                 ▼
┌─────────────────────────────────────────────────────────────────────┐
│  packages/engineering-core — pure, deterministic, no I/O            │
│                                                                     │
│   units ─→ rules ─→ disciplines ─→ layout model ─→ BOQ + analyses   │
│      dimensional   pure functions   reactive graph                  │
│      safety        + jurisdiction   (spreadsheet                    │
│                    packs            recalculation)                  │
└─────────────────────────────────────────────────────────────────────┘
```

Four ideas carry the whole design.

**A reactive propagation graph.** Values are `Source` cells and `Derived` cells that discover
their dependencies automatically as they compute. A change marks dependents stale; reading
recomputes only what is actually observed. Adding a fixture re-sizes exactly the pipes on its
path and nothing else. It is spreadsheet recalculation applied to engineering objects, in
about 100 lines.

**Dimensionally safe quantities.** `Quantity` carries its dimension. Adding metres to litres
per second throws rather than producing a plausible wrong number. Millimetres and metres round
-trip losslessly.

**Pure rules with traces.** A rule is `(inputs, jurisdiction) → { value, pass, trace }`. No
state, no I/O, no hidden defaults. The trace is not logging — it is the deliverable. And when
nothing in the catalogue satisfies the constraints, a rule returns `null` with an explanation.
It never guesses.

**Event sourcing.** Every edit is an event appended to a log. The model is the fold of that
log, which gives undo, redo, audit, deterministic replay and jurisdiction switching for free —
and it is what makes an old project pick up today's engine when you reopen it. The history is
transactional: an event that would leave the model unfoldable is rolled back rather than
poisoning the document.

### Why zero dependencies

The engine and the server import nothing but the Node standard library. No framework, no ORM,
no bundler, no build step. That is a deliberate constraint, and it buys three things:

- **Auditability.** An engineer or a security reviewer can read the whole path from HTTP
  request to sized pipe without leaving this repository.
- **Longevity.** Engineering software outlives web framework fashions. There is nothing here
  to migrate off in three years.
- **Supply chain.** Zero runtime dependencies is zero runtime supply-chain surface. The two
  browser libraries (three.js, web-ifc) are served from this origin under a strict CSP.

The trade-off is real: some things that a framework gives you for free are written here by
hand. Where that cost outweighs the benefit — the WebAssembly IFC parser, the 3D renderer —
a library is used.

## Security

Designed to be hosted, not just run locally. `SECURITY.md` documents the model in full;
the summary:

- **Accounts** with scrypt-hashed passwords, constant-time verification, and identical cost
  and response for an unknown username as for a wrong password.
- **Sessions** carried in an opaque random token; only its SHA-256 is stored, so the session
  file is not a credential. `HttpOnly`, `SameSite=Strict`, `Secure` behind TLS.
- **Authorisation** on every request. Workspaces have an owner and an explicit member list;
  a workspace id in a header or query string is a claim, never a grant. Unknown and
  unauthorised both return `404` so ids cannot be probed.
- **Input validated at the boundary** into known event shapes with in-range values, then
  checked for referential integrity by the model, with any failure rolled back.
- **Output encoded at every sink** — HTML escaping in the report and the UI, formula-injection
  defusing in the CSV export.
- **A strict CSP** with no `unsafe-inline` for scripts; the two legitimate inline scripts are
  allowed by the hash of their exact contents.
- **Resource limits** on body size, events, resident documents, live connections, and rate
  limits on sign-in, registration and the expensive endpoints.

These properties are tested, not just asserted: `apps/studio/test/security.test.ts` runs a real
server and checks each one.

## Deploying

```bash
export BG_SESSION_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
export NODE_ENV=production
export BG_BEHIND_TLS_PROXY=true   # TLS terminated by your proxy
export BG_ALLOW_REGISTRATION=true # create your accounts, then set this back to false
npm start
```

Or with the provided container:

```bash
BG_SESSION_SECRET=... docker compose up -d
```

Put a TLS-terminating reverse proxy in front. Back up `BG_DATA_DIR` — it holds accounts, live
documents and saved projects. `.env.example` documents every setting.

## Project layout

```
packages/engineering-core/     the rules engine — pure, deterministic, no I/O
  src/units/                   dimensionally safe quantities
  src/core/                    the reactive propagation graph
  src/rules/                   the Rule contract and registry
  src/jurisdiction/            code packs (GULF, US) — constants as data
  src/plumbing/                hydraulics, demand, drainage, vent, pressure, recirculation
  src/electrical/              ampacity, voltage drop, cable sizing
  src/hvac/                    duct sizing
  src/structural/              beams, columns, slabs
  src/model/                   the geometric layout model and auto-routing
  src/events/                  event sourcing, transactional history
  src/boq/                     quantity aggregation and costing
  src/geometry/                horizontal section cut (IFC → 2D plan)
  src/ai/                      tool bus and the numeric guardrail
  test/                        174 tests, including golden hand calculations

apps/studio/
  server.ts                    entry point: services, HTTP, graceful shutdown
  src/auth/                    passwords, sessions, accounts and workspaces
  src/http/                    errors, responses, CSP, rate limiting, static files
  src/model/                   validation, documents, serialisation
  src/report/                  design report and CSV export
  src/routes/                  the API surface
  src/realtime/                Server-Sent Events fan-out
  public/                      the browser client — vanilla JS, no framework
  test/                        71 tests over a real running server

docs/                          strategy, architecture, rules library, module contract
```

## Testing

```bash
npm run check     # typecheck + every test
npm test          # 245 tests across both workspaces
```

Three kinds of test, deliberately:

**Golden calculations.** Specific numbers checked against hand calculations, with the working
in a comment — 1 L/s through 100 m of 50 mm at C = 150 losing 0.606 m; a tee losing exactly
three times more through the branch (K = 1.8) than through the run (K = 0.6); `Pu = 4300 kN`
sizing to a 450 mm column under Gulf constants and 500 mm under US. These are what stop a
refactor from quietly changing an engineering answer.

**Property and integration tests.** That the propagation graph is genuinely incremental; that
a diamond dependency recomputes once; that a rejected edit leaves the document readable; that
the same event log under two jurisdiction packs produces two correct, different designs.

**Security tests.** A real server on an ephemeral port, checking each claim in `SECURITY.md`:
anonymous access refused, cross-workspace access invisible, traversal contained, forgery
rejected, injection neutralised.

## Status and roadmap

Working today: four disciplines and seven media; two jurisdictions; the hydraulic network
solver with minor losses, auto-fix and hot-water recirculation balancing; drainage and vent
connectivity validation with stack-versus-branch sizing; beams, columns with multi-storey load
accumulation, and slabs; IFC section-cut import; live multi-user collaboration; the design
report and BOQ export; the grounded copilot.

Known limits, stated plainly because engineering software should not overclaim:

- Elevation is a per-node property; the plan is 2D and 3D infers routing from it. True 3D
  routing with clash detection is not implemented.
- Structural design is preliminary: short columns without slenderness or P-M interaction,
  deflection-governed slabs on rectangular panels without openings.
- Collaboration is state broadcast over a shared log — last-write-wins, not operational
  transforms or a CRDT.
- DWG import is not implemented. IFC import produces a traceable 2D plan and a 3D reference.
- Unit rates and several code constants are representative and carry `VERIFY` markers until
  someone checks them against a published source.

Next: verifying constants against adopted codes jurisdiction by jurisdiction, deeper structural
analysis, more jurisdictions, and DWG import. See the issues, and
`docs/05-development-roadmap.md`.

## Contributing

Contributions are welcome, and `CONTRIBUTING.md` explains what the codebase expects. The short
version: engineering numbers come only from the engine, every result carries its trace, code
constants live in jurisdiction packs, rules fail closed, and anything numeric needs a golden
test.

If you are an engineer rather than a programmer, the most valuable contribution is verifying a
constant against the code you actually work to — there is an issue template for exactly that.

## Licence

Apache License 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).

Permissive, with an explicit patent grant, so it can be used commercially and built on freely.
If you need different terms for a commercial product, open a discussion.

---

**Decision-support software.** Every size, quantity and rate it produces is preliminary and
requires review, analysis and sign-off by a qualified Engineer of Record. Jurisdiction
constants shipped here are representative values pending verification against the code adopted
for your project. This tool exists to make an engineer faster and their reasoning auditable —
not to replace their judgement or their liability.
