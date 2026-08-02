Write, run, and upload the two executable contract suites that protect this
project — the peer contract systems of spec 32. Both are written and run from
your real code on this machine; only the finished suites and their metadata are
uploaded, never source:

- **structural** — real unit tests over the internal map (Ruby/RSpec,
  JS/TS/Vitest, or Python/pytest), one per interface.
- **behavioral** — Gherkin `.feature` contracts over the Surface Map (what the
  product does), run by the fixed BDD runner for the stack (`cucumber`,
  `@cucumber/cucumber`, or `pytest-bdd`).

Neither replaces the other; they have independent versions, runs, and lamps.

Do this:
1. Run `npx -y --loglevel=error unitbob@0.2.9 suite-prepare` with exactly one
   defect-context option. If the user or acceptance material named a known defect, append
   `--known-defect='<exact defect description>'`; when a fixed revision was
   supplied, also append `--fixed-revision='<exact revision>'`. Never omit the
   first option merely because the defect is visible in the conversation. If no
   defect was supplied, append `--no-known-defect`; the connector rejects an
   ambiguous omission. It
   confirms a supported stack and materializes the Ruby boot helper
   `.unitbob/structural/unitbob_helper.rb` (RSpec only), fetches both peer
   assignments and each branch's recipe, and writes the task to
   `.unitbob/suite-build/request.json`. If it reports an unsupported project,
   tell the user and stop. If it reports there is no current map, build it first
   by following `map.md` next to this file, then start this workflow again.
2. Read `.unitbob/suite-build/request.json`. It has `project_root`,
   `output_path`, and `branches` — one per contract system, each with its
   `suite_kind`, `source_digest`, `path_root`, `recipe`, `assignment`, and
   `runner_manifest`. **Copy each branch's `runner_manifest` into your answer
   verbatim.** The connector detected the stack and filled it in; the server
   accepts only the exact combinations it names, so a manifest you compose
   yourself is the field most likely to be rejected after all the work is done.
   Every branch in the request carries a complete one — a branch the connector
   could not describe is not in the request at all, and it says why. Never add a
   branch that is not there, and never edit a manifest that is.
   Nothing has checked whether the app boots in its test environment:
   `suite-prepare` confirms the stack and provisions the BDD runner, and it
   never runs your app. If the app turns out not to boot, that is a real defect,
   not a setup step to fix first — it will show up as a red lamp. Write the
   scenarios and let the lamp be red; don't stop to repair the app before
   generating.
3. Build and run **both** branches locally, each following its own
   `recipe.text`:
   - **structural** — for every interface, a real unit test that exercises
     production code and asserts an observable business outcome; only
     collaborators and boundaries stubbed. Bake the supplied `case_marker` into
     every test name. Write the complete file under `.unitbob/structural/`
     (RSpec: `architecture_map_contracts_spec.rb` starting with
     `require_relative 'unitbob_helper'`; Vitest: `architecture_map_contracts.test.ts`;
     pytest: `test_architecture_map_contracts.py`), run it, and iterate to green.
   - **behavioral** — one `Scenario` per promise the capability makes, whose
     Given/When/Then read as product behavior, each tagged with the capability's
     `@case_marker`. A whole business area behind one loop-over-every-route
     scenario is not a contract: its red lamp tells the vibecoder that everything
     is broken and nothing about which workflow failed. Write the `.feature` and
     **one step-definition file per capability** (plus one shared helper file)
     under `.unitbob/behavioral/`, install the fixed BDD runner's pinned version
     into an isolated environment there if missing, then run the whole bundle.
     Repair
     undefined/ambiguous/pending steps because they mean the harness is broken;
     application failures remain red. Never weaken their assertions to get green.
     The generator must not put `bdd_quality_review`, `known_defect_probe`, or
     `known_defect_context` in `test_metadata`; the connector rejects this
     self-review. An independent reviewer handles them after the candidate is
     complete.
   - Cover every assigned id exactly once in each branch: `covered` (marker on
     real tests/scenarios) or `unguarded` (with a business reason). Never mint or
     alter a marker. Use plain business language; never surface `Class#method`.
   - Do not upload source. Do not touch the project's own `spec/`, `features/`,
     `tests/`, manifest, or lockfile.
4. Write strict JSON only to `output_path`, one entry per branch you built:
   ```json
   { "branches": [
     { "suite_kind": "structural",
       "suite_file": { "path": ".unitbob/structural/...", "content": "..." },
       "runner_manifest": <copied verbatim from this branch in the request>,
       "test_metadata": { "capabilities": [...] } },
     { "suite_kind": "behavioral",
       "suite_file": { "path": ".unitbob/behavioral/features/surface_contracts.feature",
                       "support_files": [ { "path": ".unitbob/behavioral/step_definitions/client_management_steps.rb" } ] },
       "runner_manifest": <copied verbatim from this branch in the request>,
       "test_metadata": { "capabilities": [...] } }
   ] }
   ```
   **A file you already wrote to disk needs only its `path`** — the connector
   reads the bytes from there, so do not paste a second copy into this JSON.
   Inline `content` only for a file that is not on disk. Copy each id's
   `contract_key` and `case_marker` verbatim. A branch you truly
   cannot build gets `{ "suite_kind": ..., "build_error": { "message": "..." } }`
   instead — it never blocks the peer branch. Never emit `spec_rb`, `rspec_id`,
   `example_id`, or `run_command`. No prose around the JSON.
5. If no behavioral candidate was built (or it carries `build_error`), skip the
   review step and continue to step 7 so the structural peer can still publish.
   Otherwise run `npx -y --loglevel=error unitbob@0.2.9 suite-review-prepare`. It reads the
   finished behavioral candidate, runs that exact candidate to capture machine
   evidence (and repeats it in a disposable worktree when a fixed revision was
   supplied), keeps that evidence in its own
   `.unitbob/suite-build/candidate-run.json`, and writes a digest-bound request
   to `.unitbob/suite-build/review-request.json`. The raw runner report rides in
   the request only when a known defect was supplied, because only then does the
   reviewer have to cite which Scenario it turned red.
6. Give only that request plus the referenced suite bundle to an
   **independent reviewer** in a separate agent/subagent with fresh context. If
   one is unavailable, do not upload the behavioral branch. The reviewer performs
   the BDD quality review: cover every important surface, trace each Given
   record into Then, confirm When drives every declared public surface, and
   reject generic load/success results when the Scenario promises a record,
   change, message, or side effect. Availability is valid only when availability
   itself is the product promise.

   Write strict JSON only to the request's `output_path`
   (`.unitbob/suite-build/behavioral_review.json`): copy its exact
   `candidate_digest`; add `bdd_quality_review` with `reviewer: "independent"`
   and one `scenario_reviews` entry per Scenario. Each entry has exact
   `scenario`, `case_marker`, verified `public_surfaces`, concrete
   `given_then_evidence`, `outcome`, `outcome_kind` (`specific` or
   `availability`), and `verdict: "pass"`. Add `known_defect_probe` exactly as
   the recipe and connector-owned `known_defect_context` require. A named defect
   must be `detected` red, or `verified` red then green when a fixed revision is
   supplied; copy the exact defect text, revisions, and Scenario from the
   connector-owned `candidate_run`/`fixed_candidate_run` evidence and never call
   it `not_supplied`. This is a local process attestation, not authenticated
   reviewer identity; do not describe it as cryptographic proof of independence.
7. Run `npx -y --loglevel=error unitbob@0.2.9 put-suite-build`. It uploads both
   branches in one batch, each validated and published independently, and then
   runs every branch it published and prints the server's result for each plus
   the map URL. This is the last command: it lights the lamps itself, so never
   ask the user to run the checks to finish generating. If it reports that
   nothing was published, or that it published but could not finish the run, say
   so plainly and stop — the suite is safe either way, and in the second case
   asking the user to run the Unitbob checks finishes the job.

Then tell the user, in plain business language, what is guarded on each map and
what is not yet testable, and include the map URL. Two claims, two sources:
whether a branch was published comes from the upload lines, and what is green,
red, or in error comes only from the server's run summaries printed after them.
Never turn a local build run, or a branch that did not publish, into a claim
about what the map now shows — a branch you could not publish has no results at
all, so say it was not published and why. When the command prints a
`Partial success` line, it names exactly those branches: report them as not
published, and read every summary below it as covering only the branches that
did publish. When the server's summaries report failures, say plainly: "found N
live defects — they are red on the map" — a red first suite is a discovery, not
a failure. Do not copy recipe text into this project — it is fetched from the
server each time.

Linking is automatic: if a command prints `Linked this project to Unitbob as X.`,
relay that line to the user verbatim. Never ask for or guess a repo_id.
