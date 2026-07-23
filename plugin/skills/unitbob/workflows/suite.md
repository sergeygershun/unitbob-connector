Write, run, and upload the executable guardrail test suite that proves this
project's business capabilities behave correctly. The suite is real unit tests
in the project's own primary stack — Ruby/RSpec, JS/TS/Vitest, or Python/pytest
— written and run from your real code on this machine; only the finished
guardrail file and its capability metadata are uploaded — never source.

Do this:
1. Run `npx -y --loglevel=error unitbob@0.1.11 suite-prepare`. This confirms at
   least one supported stack is present (Rails + RSpec, Vitest, or pytest),
   materializes the Ruby boot helper `.unitbob/guardrails/unitbob_helper.rb`
   (used only by RSpec suites), fetches the generate recipe and the per-block
   capability assignment, and writes the task to
   `.unitbob/suite-build/request.json`. If it reports an unsupported project,
   tell the user and stop. If it reports there is no current map, build it
   first by following `map.md` next to this file, then start this workflow again.
2. Read `.unitbob/suite-build/request.json`. It contains `project_root`,
   `map_digest`, `output_path`, `recipe`, and `blocks` (per block, its
   capabilities to guard, each with a precomputed `contract_key` and
   `case_marker`).
3. Build and run the suite locally:
   - Choose **one** primary stack — the language the business code is written
     in. One suite, one stack, one runner (Jest is not supported; JS/TS means
     Vitest only).
   - Read source files directly from `project_root` with local file tools. Do not
     upload source anywhere.
   - Follow `recipe.text`: for every capability, write a real unit test that
     exercises production code and asserts an observable business outcome — only
     collaborators and external boundaries stubbed. A capability may have several
     focused tests. A capability blocked by **broken code** gets a red test
     that fails for the stated defect reason — not `unguarded`; `unguarded` (with
     a reason) is only for capabilities with no honest unit seam. Cover every
     assigned `interface_id` exactly once.
   - Bake the supplied `case_marker` into every test name
     (`it "[ubc_…] …"` / `it("[ubc_…] …", …)` / `def test_ubc_…_scenario():`) —
     never mint or alter a marker.
   - Write the **complete** guardrail file under `.unitbob/guardrails/`
     (RSpec: `architecture_map_contracts_spec.rb`, starting with
     `require_relative 'unitbob_helper'` — never require `rails_helper`
     directly; Vitest: `architecture_map_contracts.test.ts`; pytest:
     `test_architecture_map_contracts.py`), run it with the stack's runner
     (RSpec: `bundle exec rspec <file> --options .unitbob/guardrails/rspec.opts --format json`
     — the `--options` flag keeps the project's own `.rspec` out of the run;
     Vitest: `npx vitest run <file>`; pytest: `python -m pytest <file>`),
     and iterate until every non-defect test is green; defect tests must
     fail for their stated defect reason, not from test-setup mistakes.
   - Use plain business language for headlines and scenario descriptions; never
     surface `Class#method`.
   - Write strict JSON only to `output_path`:
     `{ "suite_file": { "path": ".unitbob/guardrails/...", "content": "...the file you ran..." }, "runner_manifest": { "language": ..., "framework": ..., "result_format": ..., "runner": ... }, "test_metadata": { "capabilities": [...] } }`,
     copying each capability's `contract_key` and `case_marker` verbatim from
     the assignment. Never emit `spec_rb`, `rspec_id`, `example_id`, or
     `run_command`. No Markdown or prose around the JSON. If you cannot produce
     a valid file and JSON for the whole assignment, write nothing.
4. Run `npx -y --loglevel=error unitbob@0.1.11 put-suite-build` to upload the
   finished suite. It verifies your selected stack against local project
   markers — a mismatch fails closed and uploads nothing.

Then tell the user, in plain business language, which capabilities are now guarded
and which are not yet testable, and include the map URL. If any defect tests
are red, say plainly: "found N live defects — they show as red lamps on the map"
— a red first suite is a discovery, not a failure. Do not copy recipe text
into this project — it is fetched from the server each time.

Linking is automatic: if a command prints `Linked this project to Unitbob as X.`,
relay that line to the user verbatim. Never ask for or guess a repo_id.
