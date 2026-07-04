---
description: Generate the executable guardrail test suite for this project from local code.
---

Write, run, and upload the executable guardrail test suite that proves this
project's business capabilities behave correctly. The suite is real RSpec unit
tests written and run from your real code on this machine; only the finished spec
file and its capability metadata are uploaded — never source.

Do this:
1. Run `npx -y --loglevel=error unitbob@0.1.5 suite-prepare`. This confirms the runtime is supported
   (Rails + RSpec), materializes the boot helper
   `.unitbob/guardrails/unitbob_helper.rb`, fetches the generate recipe and the
   per-block capability assignment, and writes the task to
   `.unitbob/suite-build/request.json`. If it reports an unsupported runtime, tell
   the user and stop. If it reports there is no current map, run `/unitbob map`
   first and stop.
2. Read `.unitbob/suite-build/request.json`. It contains `project_root`,
   `map_digest`, `output_path`, `recipe`, and `blocks` (per block, its
   capabilities to guard).
3. Build and run the suite locally:
   - Read source files directly from `project_root` with local file tools. Do not
     upload source anywhere.
   - Follow `recipe.text`: for every capability, write a real unit test that
     exercises production code and asserts an observable business outcome — only
     collaborators and external boundaries stubbed. A capability may have several
     focused examples. A capability blocked by **broken code** gets a red test
     that fails for the stated defect reason — not `unguarded`; `unguarded` (with
     a reason) is only for capabilities with no honest unit seam. Cover every
     assigned `interface_id` exactly once.
   - Write the **complete** spec file starting with
     `require_relative 'unitbob_helper'` (the boot helper materialized next to
     it — never require `rails_helper` directly) at
     `.unitbob/guardrails/architecture_map_contracts_spec.rb`, run it
     (`bundle exec rspec .unitbob/guardrails/architecture_map_contracts_spec.rb --format json`),
     and iterate until every non-defect example is green; defect examples must
     fail for their stated defect reason, not from test-setup mistakes.
   - Use plain business language for headlines and scenario descriptions; never
     surface `Class#method`.
   - Write strict JSON only to `output_path`:
     `{ "spec_rb": "...the file you ran...", "test_metadata": { "capabilities": [...] } }`,
     deriving each example's `rspec_id` from the final run. An `rspec_id` is the
     bracket suffix only — `"rspec_id": "[1:1:1:1]"`, never the
     `./path/spec.rb[...]` form rspec's JSON `id` field carries. No Markdown or
     prose around the JSON. If you cannot produce a valid file and JSON for the
     whole assignment, write nothing.
4. Run `npx -y --loglevel=error unitbob@0.1.5 put-suite-build` to upload the finished suite.

Then tell the user, in plain business language, which capabilities are now guarded
and which are not yet testable, and include the map URL. If any defect examples
are red, say plainly: "found N live defects — they show as red lamps on the map"
— a red first suite is a discovery, not a failure. Do not copy recipe text
into this project — it is fetched from the server each time.

Linking is automatic: if a command prints `Linked this project to Unitbob as X.`,
relay that line to the user verbatim. Never ask for or guess a repo_id.
