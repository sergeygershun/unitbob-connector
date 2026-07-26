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
1. Run `npx -y --loglevel=error unitbob@0.2.4 suite-prepare`. It confirms a
   supported stack, materializes the Ruby boot helper
   `.unitbob/structural/unitbob_helper.rb` (RSpec only), fetches both peer
   assignments and each branch's recipe, and writes the task to
   `.unitbob/suite-build/request.json`. If it reports an unsupported project,
   tell the user and stop. If it reports there is no current map, build it first
   by following `map.md` next to this file, then start this workflow again.
2. Read `.unitbob/suite-build/request.json`. It has `project_root`,
   `output_path`, and `branches` — one per contract system, each with its
   `suite_kind`, `source_digest`, `path_root`, `recipe`, and `assignment`.
   Before writing a large batch of scenarios, make sure the app actually boots
   in its test environment (the build preflight in `suite-prepare` already smoke-
   runs it; trust that). If it does **not** boot, that is a real defect, not a
   setup step to fix first — it will show up as a red lamp. Write the scenarios
   and let the lamp be red; don't stop to repair the app before generating.
3. Build and run **both** branches locally, each following its own
   `recipe.text`:
   - **structural** — for every interface, a real unit test that exercises
     production code and asserts an observable business outcome; only
     collaborators and boundaries stubbed. Bake the supplied `case_marker` into
     every test name. Write the complete file under `.unitbob/structural/`
     (RSpec: `architecture_map_contracts_spec.rb` starting with
     `require_relative 'unitbob_helper'`; Vitest: `architecture_map_contracts.test.ts`;
     pytest: `test_architecture_map_contracts.py`), run it, and iterate to green.
   - **behavioral** — for every capability, one or more `Scenario`s whose
     Given/When/Then read as product behavior, each tagged with the capability's
     `@case_marker`. Write the `.feature` and its step definitions under
     `.unitbob/behavioral/`, install the fixed BDD runner's pinned version into
     an isolated environment there if missing, run the whole bundle, and iterate
     to green — no undefined/ambiguous/pending steps.
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
       "runner_manifest": { "language": ..., "framework": ..., "result_format": ..., "runner": ... },
       "test_metadata": { "capabilities": [...] } },
     { "suite_kind": "behavioral",
       "suite_file": { "path": ".unitbob/behavioral/features/surface_contracts.feature", "content": "...",
                       "support_files": [ { "path": ".unitbob/behavioral/step_definitions/...", "content": "..." } ] },
       "runner_manifest": { "language": ..., "framework": ..., "result_format": ..., "runner": ..., "runner_version": "..." },
       "test_metadata": { "capabilities": [...] } }
   ] }
   ```
   Copy each id's `contract_key` and `case_marker` verbatim. A branch you truly
   cannot build gets `{ "suite_kind": ..., "build_error": { "message": "..." } }`
   instead — it never blocks the peer branch. Never emit `spec_rb`, `rspec_id`,
   `example_id`, or `run_command`. No prose around the JSON.
5. Run `npx -y --loglevel=error unitbob@0.2.4 put-suite-build` to upload both
   branches in one batch. Each is validated and published independently.

Then tell the user, in plain business language, what is guarded on each map and
what is not yet testable, and include the map URL. If any defect tests are red,
say plainly: "found N live defects — they show as red lamps on the map" — a red
first suite is a discovery, not a failure. Do not copy recipe text into this
project — it is fetched from the server each time.

Linking is automatic: if a command prints `Linked this project to Unitbob as X.`,
relay that line to the user verbatim. Never ask for or guess a repo_id.
