Build, run, review, and publish the two peer Unitbob contract suites. Source stays
on this machine; only the finished suites and metadata are uploaded.

- **structural** protects internal interfaces with real unit examples.
- **behavioral** protects business outcomes with Gherkin scenarios.

Neither replaces the other. Follow this finite workflow exactly: one planning
pass, one fan-out, assembly and validation, at most one host-owned shared harness
correction, one fresh repair rotation, exactly one final run, and one review.
Never continue a coordinator or worker context after its bounded phase.

1. Run `npx -y --loglevel=error unitbob@0.4.0 suite-prepare` with exactly one
   defect-context option. Use `--known-defect='<exact description>'` (and
   `--fixed-revision='<revision>'` when supplied), otherwise use
   `--no-known-defect`. This command checks the supported stack, provisions the
   runner, materializes the structural helper and connector-owned behavioral
   World, probes that World, and writes
   `.unitbob/suite-build/request.json`. **If it does not write that file, relay
   its message to the user as it stands and stop.** Do not work around a
   `fixable` profile failure or start fan-out without a request.

2. Read `.unitbob/suite-build/request.json`. It names `project_root`,
   `output_path`, and the requested `branches`. Copy each branch's
   `runner_manifest` verbatim. Never invent or edit one and never add a branch
   absent from the request.

   The request also carries a `budget`:
   `{ "workers": 4, "review_rounds": 2, "repair_rounds": 8 }`. Treat it exactly
   as `runner_manifest`: do not exceed it and do not invent it. Do not sort the
   fields into ones you think are checked and ones you think are not. If an old
   request has no `budget` at all, say so in one line and work without a ceiling.
   The workers ceiling is **per branch**, not across the build.

3. In one planning pass write strict JSON to
   `.unitbob/suite-build/worker-plan.json`. Compute `request_digest` as SHA-256
   of the exact `request.json` bytes. The plan has this shape:

   ```json
   { "request_digest": "<sha256>", "workers": [
     { "branch": "structural|behavioral", "worker_id": "stable-id",
       "capability_ids": ["opaque ids copied from assignment"],
       "promises": ["finite business promises"],
       "planned_cases": ["finite example or scenario intents"],
       "source_paths": ["initial local paths"],
       "owned_paths": ["files only this worker may write"],
       "harness_path": ".unitbob/...connector-owned helper...",
       "limits": { "planned_cases": 3, "fact_finder_lookups": 8 },
       "done_when": "all planned cases are written and checkpointed" }
   ] }
   ```

   Plan every requested branch. Use
   `1..min(budget.workers, capability_count)` workers on each and never create
   an empty slice. Assign every capability exactly once, use globally unique
   worker ids and owned paths, and balance non-empty slices so the largest
   planned-case count is at most 1.5 times the smallest. Balance visible
   business complexity too, but do not invent weights or a scheduler.

   A promise may have several planned behavioral scenario intents. Usually plan
   3–6 scenarios per capability; more than 8 requires an explanation in the
   intent. Route aliases and technical mirrors do not earn scenarios without a
   different business outcome. `surface_budget` is a ceiling, never a quota;
   unselected assigned surfaces are `deferred_surfaces`, not `unreachable`.

4. Run `npx -y --loglevel=error unitbob@0.4.0 validate-worker-plan`. If
   validation exits non-zero, fix the whole reported batch and run the gate
   again. If it remains non-zero, stop before fan-out. Do not replace this gate
   with a receipt, hook, or home-grown orchestrator.

5. For every plan item launch the named agent `unitbob:suite-worker`, passing
   only that plan item and the referenced request paths. Its frontmatter pins
   Sonnet and `maxTurns: 60`; never launch a generic subagent and never continue
   an exhausted context. Start a branch's workers together, in one go.
   Sequential slices save nothing and finish later.

   The bounded flow applies to structural and behavioral alike. The behavioral
   World and later selection review remain behavioral-only. Workers write only
   their `owned_paths` plus
   `.unitbob/suite-build/checkpoints/<branch>-<worker-id>.json`. They create the
   checkpoint before source research and update it after every completed
   promise. Ask closed questions with the files to look in. They may ask no more
   than eight closed lookups of the named
   `unitbob:fact-finder`, with no more than **eight** lookups per worker; a generic lookup agent has no ceiling on model, turn
   count, or answer length. Workers never run the suite themselves, never do
   branch-global validation, never edit another slice or connector-owned
   harness, and get one final read of their owned files—not a self-validation
   script loop. Partial files and unresolved promises survive `maxTurns`.

6. Run `npx -y --loglevel=error unitbob@0.4.0 validate-worker-checkpoints` after
   fan-out and before assembly or repair. It verifies one compact checkpoint per
   plan item against the exact request and plan digests, worker id, promises,
   and owned paths. A stale or invalid checkpoint never goes to repair: record a
   `build_error` for that branch and continue its peer.

7. Assemble each valid branch without rereading the whole source tree. Follow
   each server recipe and preserve every opaque id, `contract_key`, and
   `case_marker`. Structural examples exercise production code and assert an
   observable outcome. Behavioral Given/When/Then steps drive real public
   behavior. Workers do not edit
   `.unitbob/behavioral/step_definitions/00_unitbob_world.rb`, copy its contents,
   or use `render_template`; use only the World's status and redirect API.
   Application and FactoryBot-specific login/domain setup belongs in host-owned
   shared steps.

   Write strict JSON only to the request's `output_path`, one entry for every
   requested branch:

   ```json
   { "branches": [
     { "suite_kind": "structural", "suite_file": { "path": ".unitbob/structural/..." },
       "runner_manifest": "<verbatim request object>",
       "test_metadata": { "capabilities": [] } },
     { "suite_kind": "behavioral",
       "suite_file": { "path": ".unitbob/behavioral/features/...",
         "support_files": [{ "path": ".unitbob/behavioral/step_definitions/business_steps.rb" }] },
       "runner_manifest": "<verbatim request object>",
       "test_metadata": { "worker_plan_digest": "<exact plan digest>", "capabilities": [] } }
   ] }
   ```

   A file already on disk needs only its path. Never list the connector-owned
   World as a host support file. A branch that cannot finish gets
   `{ "suite_kind": "...", "build_error": { "message": "exact cause" } }`;
   never omit it. The generator must not put `bdd_quality_review`, `selection_review`,
   `known_defect_probe`, `known_defect_context`, or runner reports in generator
   `test_metadata`.

8. Run `npx -y --loglevel=error unitbob@0.4.0 validate-build` once after merge.
   It batch-checks duplicate step expressions, markers, metadata, assigned ids,
   surface arithmetic, paths, and files. Correct that mechanical batch during
   assembly; workers do not repeat it locally.

9. Run `npx -y --loglevel=error unitbob@0.4.0 run-local` once for the assembled
   branches. The connector owns the exact runner commands. A runner that never
   starts is a harness failure, not a red test. If the runner never started, it
   died before the first test or scenario; report its exact error, upload nothing
   for that branch, and do not build on that harness. A runner that starts and reaches production code may expose a
   real application failure. Application failures remain red. Let the lamp be red. Don't stop to repair the app before
   generating, and never weaken a check to get green.

   Group the failures by the verbatim text of the error. Look yourself at any
   error that turns up under more than one worker: it is coordinator-owned. A
   host-owned shared step is yours, fixed once and never handed back;
   the connector-owned World is never locally patched. A World incompatibility
   missed by the pre-fan-out probe makes the behavioral branch a `build_error`.
   An application stack remains red. For owned-file failures, and for every
   valid checkpoint with `unresolved_promises`, create one narrow failure packet
   containing only its plan item, checkpoint, owned paths, and related traces.

10. Launch one fresh `unitbob:suite-repair-worker` per failure packet. It first
    completes `unresolved_promises` while preserving finished files, then fixes
    only related harness errors. Its frontmatter pins Sonnet and `maxTurns: 20`.
    Never continue either generation or repair worker, and never give a slice a
    second repair incarnation. After this one fresh repair rotation, run each
    affected branch exactly once as the final run. Remaining harness failures or
    unfinished promises become that branch's honest `build_error`; real
    application failures remain executable and red.

11. If behavioral is a `build_error`, skip review and keep the structural peer.
    Otherwise run
    `npx -y --loglevel=error unitbob@0.4.0 suite-review-prepare`. It runs and binds
    the exact candidate, then writes
    `.unitbob/suite-build/review-request.json`. That request includes the
    original behavioral assignment, its worker-plan items, and exact
    `plan_digest`, as well as the existing candidate and optional known-defect
    evidence.

12. There is always exactly one reviewer. Give that request and referenced suite
    to one independent reviewer in a fresh context. If one is unavailable, do not upload the behavioral branch.
    Keep the existing BDD quality review: one
    `scenario_reviews` entry per Scenario, with exact scenario, marker, verified
    `public_surfaces`, Given→Then evidence, outcome, outcome kind, and one of
    `pass`, `pass_with_reservation`, or `does_not_pass`. A `does_not_pass`
    objection owes only `scenario`, `case_marker`, `verdict`, and that text in
    `reviewer_objection_text`; there is no answer that consists of writing nothing.

    Add a sibling `selection_review` with the exact `plan_digest` and exactly one
    verdict for every assigned behavioral capability. `pass` confirms that the
    plan kept each important business outcome and honestly deferred the rest.
    `does_not_pass` also supplies a non-empty `reviewer_objection_text` naming the
    lost promise or bad merge. Selection objections are recorded and do not
    start repair or block publication. Add the existing `known_defect_probe` as
    required. Write strict JSON only to
    `.unitbob/suite-build/behavioral_review.json`.

13. Run `npx -y --loglevel=error unitbob@0.4.0 put-suite-build` exactly once. It
    validates and publishes each branch independently, runs every branch it published,
    and prints the server summaries and map URL. Never ask the user
    to run the checks to finish generating.

Report publication only from upload lines and colors only from the server's run
summaries. Never turn a local build run into a claim about the map. Say plainly
when a peer was not published and why; red tests are live defects, not a failed
generation. Linking is automatic—never ask for or guess a repo id.
