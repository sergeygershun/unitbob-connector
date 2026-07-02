---
description: Act on a red guardrail — fix the code, or accept a deliberate behaviour change.
argument-hint: <interface_id>
---

Act on the red guard `$ARGUMENTS` (a business capability whose unit test failed).
The handle is copied from the red lamp on the map. Your code never leaves the
machine. There are two honest responses — fix the code, or accept that the
behaviour changed on purpose.

Do this:
1. Run `npx unitbob@0.1.1 fix-prepare $ARGUMENTS`. This fetches the per-capability
   repair data (the business behaviour, the latest failure, a source anchor) and
   writes the task to `.unitbob/fix/request.json`. If it reports the check is not
   failing or the suite is stale, report that and stop.
2. Read `.unitbob/fix/request.json`. It contains `project_root`, `interface_id`,
   `headline`, `failure_message`, an optional `anchor`, and `prompt`. Use
   `prompt` as your repair brief; it is the same text the web map copies from the
   red lamp. The whole spec file is already on disk at
   `.unitbob/guardrails/architecture_map_contracts_spec.rb` — read it to see
   exactly what the failing examples assert.
3. Decide and act:
   - **Fix (default):** the behaviour should still hold. Edit **only application
     code** under `project_root` — never anything under `.unitbob/` and never the
     guard. Make the smallest change that satisfies `headline`. Do not weaken or
     game the examples. Then tell the user to run `/unitbob:check`.
   - **Accept (the behaviour changed on purpose):** re-author **only this
     capability's** examples in
     `.unitbob/guardrails/architecture_map_contracts_spec.rb`, run the whole file
     to green, re-derive `test_metadata`, and republish with
     `npx unitbob@0.1.1 put-suite-build`. This makes a new suite version against
     the same map.
4. Tell the user, in plain business language, what you changed.
