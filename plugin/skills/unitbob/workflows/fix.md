Act on the red check the user named — `<test_id>` below — a business capability
whose contract failed. It may be an interface on the internal map or a capability
on the Surface Map; the same two honest responses apply. The handle and the
suite digest are copied from the red lamp on the map. Your code never leaves the
machine.

Do this:
1. Run `npx -y --loglevel=error unitbob@0.3.0 contract-prompt <suite_digest> <test_id> [fix|accept]`.
   This fetches the ready-to-run brief for that exact suite version and intent
   (the business behaviour, the latest failure, the constraints, and where the
   contract lives locally) and prints it. If it reports the check is not failing,
   the version is no longer current, or the suite is stale, report that and stop.
2. Use the printed `prompt` as your brief. The whole suite is already on disk —
   structural under `.unitbob/structural/`, behavioral under
   `.unitbob/behavioral/` (the `.feature` plus its step definitions). Read it to
   see exactly what the failing contract asserts.
3. Decide and act:
   - **Fix (default):** the behaviour should still hold. Edit **only application
     code** under the project root — never anything under `.unitbob/` and never
     the contract. Make the smallest change that restores the behaviour. Do not
     weaken or game the contract. Then ask the user, in plain words, to run the
     Unitbob checks again.
   - **Accept (the behaviour changed on purpose):** change **only this contract's**
     cases in its local suite (a structural test, or a behavioral `.feature`
     scenario and, if needed, shared support files) — never application code.
     Run the whole suite of that kind once. The accepted contract must exercise
     and pass its new expectation. Unrelated application failures remain red;
     only undefined, ambiguous, or pending harness steps must be repaired.
     Re-derive `test_metadata` in the suite-build output. For a behavioral suite,
     run `npx -y --loglevel=error unitbob@0.3.0 suite-review-prepare`, send the new
     digest-bound request through the independent BDD reviewer, replace its
     `bdd_quality_review`, and preserve or rerun the `known_defect_probe` as
     applicable. Only then republish with
     `npx -y --loglevel=error unitbob@0.3.0 put-suite-build`, which publishes the
     new version and runs it in the same command — so don't ask the user to run
     the checks afterwards, and take the colors from its run summaries.
     That makes a new version of only that contract system; the peer stays put.
4. Tell the user, in plain business language, what you changed or accepted.

Linking is automatic: if a command prints `Linked this project to Unitbob as X.`,
relay that line to the user verbatim. Never ask for or guess a repo_id.
