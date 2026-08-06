# Contributing to BuildGraph

Thanks for being here. This document covers how to get the project running, what
the codebase expects of a change, and the few rules that exist because this is
engineering software rather than an ordinary web app.

## Getting set up

```bash
git clone <this repository>
cd buildgraph
npm install          # links the workspaces and copies the browser assets
npm run check        # typecheck + the full test suite
npm start            # http://127.0.0.1:4317
```

Node 23.6 or newer. The project runs TypeScript directly through Node's native
type stripping, so **there is no build step** — `node server.ts` is the whole
command. Nothing is transpiled, bundled or watched.

For a first look without creating an account:

```bash
BG_AUTH_MODE=open npm start
```

That mode refuses to start on anything but loopback.

## Repository layout

```
packages/engineering-core/   the rules engine — pure, deterministic, no I/O
apps/studio/                 the HTTP server and the browser client
docs/                        design documents and the module contract
```

The dependency arrow points one way: `apps/studio` imports the engine, never the
reverse. The engine has no idea a web server exists.

## The rules that matter

**1. Numbers come from the engine, never from anywhere else.**

Every size, capacity, velocity, head loss and quantity must be produced by a rule
in `packages/engineering-core`. The server serialises what the engine computed;
the UI renders it; the copilot is given read-only tools over it. No layer above
the engine may calculate an engineering value, and the AI assistant in particular
is structurally prevented from originating one.

**2. Every result carries its own trace.**

A rule returns `{ value, pass, trace }`, where the trace holds the formula, the
inputs, the intermediate steps and the code clause. An engineer has to be able to
check the work. A rule that returns a number without showing how it got there is
not finished.

**3. Code constants are data, not code.**

Anything that changes between jurisdictions — velocity limits, fixture unit
tables, concrete strengths, cable ampacities — lives in a jurisdiction pack under
`src/jurisdiction/`. Rules read them from the pack they are handed. If you find
yourself writing a numeric literal inside a rule, it probably belongs in a pack.

Constants that have not been verified against a published code carry a `VERIFY`
marker. Keep it until someone has actually checked the source. Removing one is a
claim, so make it in a commit that says where the value came from.

**4. Fail closed.**

When no catalogue entry satisfies the constraints, return `null` with a trace
explaining why. Never fall back to a plausible-looking value. Under-sizing a drain
silently is worse than saying "nothing fits".

**5. Golden tests for anything numeric.**

New engineering logic needs a test that checks a specific number against a hand
calculation, with the working in a comment. `test/layout-pressure.test.ts` and
`test/columns.test.ts` are the pattern to follow. Tests that only assert "returns
something" do not protect an engineer from a wrong answer.

## Adding a discipline or a module

`docs/08-module-framework.md` describes the module contract: the ten slots every
discipline fills (entities, parameters, rules, validations, quantities, symbols,
and so on). `docs/modules/plumbing-ppr.md` is the worked reference.

The rule that governs this project's shape: **a new capability strengthens the
shared core rather than forking it.** If a discipline needs something the core
does not have, add it to the core as a reusable primitive and let the discipline
use it. Four disciplines share one propagation graph, one rules registry, one
event log and one bill-of-quantities aggregator, and that is what keeps the fifth
cheap to add.

## Making a change

1. Branch from `main`.
2. Keep the change focused. A pull request that fixes one thing is far easier to
   review than one that fixes three.
3. `npm run check` must pass. CI runs the same thing.
4. Match the surrounding style. The codebase uses two-space indentation, single
   quotes, semicolons, explicit return types on exported functions, and comments
   that explain *why* rather than restate the code.
5. Write a commit message that says what changed and why. If it fixes a bug,
   describe the failure it fixes.

## Pull request expectations

Include what changed, why, and how you verified it. If the change touches
engineering logic, say which reference or code clause it follows. If it touches
the security model, say which property in `SECURITY.md` it affects.

New behaviour needs tests. Bug fixes need a test that fails before the fix.

## Reporting bugs

For engineering results, the most useful report includes the jurisdiction, the
inputs, what the engine returned, what you expected, and the reference you are
comparing against. The exported project JSON (`Export` in the toolbar) reproduces
a design exactly and is the fastest way to hand one over.

For security issues, follow `SECURITY.md` instead — please do not open a public
issue.

## Licence

Contributions are accepted under the Apache License 2.0, the same licence as the
project. By submitting a pull request you confirm you have the right to license
your contribution on those terms.
