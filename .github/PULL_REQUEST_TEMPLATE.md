## What this changes

<!-- One or two sentences. What is different after this is merged? -->

## Why

<!-- The problem this solves. Link the issue if there is one: Fixes #123 -->

## How it was verified

<!-- Commands you ran, cases you checked. `npm run check` is the baseline, not the whole story. -->

- [ ] `npm run check` passes (typecheck + tests)
- [ ] New behaviour has tests; a bug fix has a test that failed before it

## If this touches engineering logic

- [ ] Every number it produces comes from a rule in `packages/engineering-core`
- [ ] The result carries a trace: formula, inputs, steps, clause
- [ ] Code constants live in a jurisdiction pack, not inline in the rule
- [ ] Unverified constants keep their `VERIFY` marker, or the commit says which source verified them
- [ ] There is a golden test checking a specific value against a hand calculation

<!-- Which code, standard or handbook does this follow? Edition and clause, please. -->

## If this touches the security model

- [ ] `SECURITY.md` still describes the system accurately
- [ ] The relevant test in `apps/studio/test/security.test.ts` still holds, or was updated deliberately

## Anything reviewers should know

<!-- Trade-offs you made, things you were unsure about, follow-up work you deliberately left out. -->
