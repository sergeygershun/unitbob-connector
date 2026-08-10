Build, run, review, and publish the two peer Unitbob contract suites. Source stays
on this machine; only the finished suites and metadata are uploaded.

- **structural** protects internal interfaces with real unit examples.
- **behavioral** protects business outcomes with Gherkin scenarios.

Neither replaces the other. Follow this finite workflow exactly: planning, one
fan-out, assembly and validation, host-owned shared harness corrections, one
fresh repair rotation, exactly one final run, and one review. Replanning after
the first slice comes back is legitimate and cheap; do it rather than force a
plan you already know is wrong. Never continue a coordinator or worker context
after its bounded phase.

1. Run `npx -y --loglevel=error unitbob@0.4.5 suite-prepare` with exactly one
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

3. Choose which lamps this build guards, before you plan anything. The
   behavioral assignment lists every capability of the product map. A build that
   takes all of them hands each worker more work than fits: on a2time,
   2026-08-10, one worker carried 8–11 capabilities, seven of eight workers
   wrote no file at all, and the run spent about 1.51M tokens on nothing.

   Read the behavioral assignment's capability list and propose the important
   ones, with a reason each in plain words. Judge from what the assignment
   already carries — `title`, `description`, and the `surfaces`, `tables` and
   `externals` lists. Money and access rights, many addresses, several external
   systems: those are readable signals. There is no weight formula and no target
   number of lamps. Aim to spread roughly one 2026-08-10 worker's load across
   several workers instead of piling it on one.

   Then ask the user in one message: these lamps, or which ones instead. **Do
   not plan or fan out before the user answers.** This is the only place in the
   whole workflow where a question is worth the user's turn, because a wrong
   choice costs the entire run. One capability is a legitimate answer. All of
   them is allowed too — say in one line that it returns the build to the size
   that did not converge on 2026-08-10. If the product map has so few
   capabilities that there is nothing to divide, do not ask: the scope is the
   whole map.

   Scope bounds the target, not the reading. A lamp is not a closed set of
   files — billing pulls in users, projects and clients — so a capability left
   out is one you do not aim at, never one you may not read.

   The structural branch is never narrowed: it covers its whole assignment. Its
   examples run in seconds, need no data setup, and repair cleanly.

   Nothing records this choice except the plan you write next. The assignment
   stays exactly as the server sent it, and the publication line still counts
   against the whole map.

   The coverage manifest you write in step 9 stays exhaustive all the same: every
   assigned capability gets exactly one answer. The lamps you guarded are
   `covered`; every lamp you left out is `unguarded` with a reason saying so in
   one plain sentence — "not in this build's scope; billing and access were
   guarded first" is a reason, "n/a" is not. An unguarded lamp is the honest
   state of a capability nobody guarded yet, and leaving it out of the manifest
   altogether is rejected at upload.

4. Write strict JSON to `.unitbob/suite-build/worker-plan.json`. Compute
   `request_digest` as SHA-256 of the exact `request.json` bytes. The plan has
   this shape:

   ```json
   { "request_digest": "<sha256>", "workers": [
     { "branch": "structural|behavioral", "worker_id": "stable-id",
       "capability_ids": ["opaque ids copied from assignment"],
       "promises": ["finite business promises"],
       "planned_cases": ["finite example or scenario intents"],
       "source_paths": ["initial local paths"],
       "owned_paths": ["files only this worker may write"],
       "harness_path": ".unitbob/...connector-owned helper...",
       "limits": { "planned_cases": 3 },
       "done_when": "all planned cases are written and checkpointed" }
   ] }
   ```

   Plan every requested branch. The behavioral branch is planned over the lamps
   the user confirmed in step 3 and no others; the structural branch is planned
   over its whole assignment. There is no ceiling on how many workers a branch
   gets: an agent re-reads its context every turn, so splitting the work never
   costs more than keeping it together. Never create an empty slice. Assign each
   planned capability exactly once and use globally unique worker ids and owned
   paths. Balance visible business complexity, but do not invent weights or a
   scheduler.

   A promise may have several planned behavioral scenario intents. Plan the
   scenarios the business outcome actually needs — no quota, in either
   direction. Route aliases and technical mirrors do not earn scenarios without
   a different business outcome. `surface_budget` is a ceiling, never a quota;
   unselected assigned surfaces are `deferred_surfaces`, not `unreachable`.

5. Run `npx -y --loglevel=error unitbob@0.4.5 validate-worker-plan`. If
   validation exits non-zero, fix the whole reported batch and run the gate
   again. If it remains non-zero, stop before fan-out. The gate checks that the
   plan is intact — digests, ids, paths, capabilities that were actually
   assigned — and no longer requires it to cover every capability in the
   assignment; that is what step 3 decided. Do not replace this gate with a
   receipt, hook, or home-grown orchestrator.

6. Seed every planned slice's checkpoint before fan-out. Write
   `.unitbob/suite-build/checkpoints/<branch>-<worker-id>.json` yourself: the
   exact request and plan digests, branch and worker id, every assigned promise
   in `unresolved_promises`, empty `completed_promises` and `written_paths` —
   and the facts you have already verified, each with its source references:

   ```json
   {"fact":"The route creates an order.","source_refs":["app/orders.rb:12"]}
   ```

   Everything every worker on the branch would otherwise discover alone belongs
   here: how a session is opened, which factory builds a paying customer, what
   the runner setup already does. On 2026-08-10 that list was assembled by hand
   halfway through the run, and the packets that received it finished
   completely.

7. Use the same named role on both Claude Code and Codex: `unitbob:suite-worker`
   on Claude Code and `suite-worker` on Codex. For every plan item launch that
   role with only the plan item and referenced request paths. The host-specific
   definition owns the cheaper model and the emergency turn fuse; never launch a
   generic subagent and never continue an exhausted context. Start a branch's
   workers together, in one go.
   Sequential slices save nothing and finish later.

   On Codex, the Unitbob definitions must already be discoverable in
   `~/.codex/agents/`; if they are missing, stop and run
   `npx -y --loglevel=error unitbob@0.4.5 codex-install`, then tell the user to
   start a new Codex thread. No Codex version is currently qualified by Unitbob
   for a per-named-agent rollout budget. Before the first bounded role, ask:
   `This Codex version cannot enforce the Unitbob worker token limit. Run this
   invocation without the limit? [Continue once / Stop]`. Stop declines before
   fan-out; Continue once applies only to this invocation. Do not emulate the
   ceiling with a supervisor, timer, hook, token ledger, or App Server.

   The bounded flow applies to structural and behavioral alike. The behavioral
   World and later selection review remain behavioral-only. Workers write only
   their `owned_paths` plus their seeded
   `.unitbob/suite-build/checkpoints/<branch>-<worker-id>.json`. They start by
   writing what the seeded facts already support and go looking only for what
   they still lack, and they update the checkpoint after every completed
   promise. Ask closed questions with the files to look in. They may ask the
   named fact-finder role (`unitbob:fact-finder` on Claude Code, `fact-finder`
   on Codex) as many closed lookups as the work needs; a generic lookup agent
   has no ceiling on model, turn count, or answer length. Workers never run the
   suite themselves, never do branch-global validation, never edit another slice
   or connector-owned harness, and get one final read of their owned files—not a
   self-validation script loop. Partial files and unresolved promises survive
   the host's emergency fuse.

   That fuse sits far above the work one plan item takes, so a worker reaching it
   is a fault of the run, not one of its outcomes. Keep its files and checkpoint,
   never call its branch successful, and say in the report that the fuse fired
   and on which slices.

   If a qualified Codex later returns `budgetLimited` or
   `session_budget_exceeded`, keep the partial files and checkpoint and ask
   `[Continue once / Stop]` before launching another bounded incarnation.
   Continue once passes the existing checkpoint and unresolved promises as a
   resume packet; the fresh worker must preserve completed state rather than
   initialize the checkpoint again. Approval applies only to that one
   incarnation. Stop follows the existing incomplete/checkpoint path. Never
   auto-resume or report the incomplete slice as successful after a budget stop.

8. Run `npx -y --loglevel=error unitbob@0.4.5 validate-worker-checkpoints` after
   fan-out and before assembly or repair. It verifies one compact checkpoint per
   plan item against the exact request and plan digests, worker id, promises,
   and owned paths. A stale or invalid checkpoint never goes to repair: record a
   `build_error` for that branch and continue its peer.

9. Assemble each valid branch without rereading the whole source tree. Follow
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

10. Run `npx -y --loglevel=error unitbob@0.4.5 validate-build` once after merge.
    It batch-checks duplicate step expressions, markers, metadata, assigned ids,
    surface arithmetic, paths, and files. Correct that mechanical batch during
    assembly; workers do not repeat it locally.

11. Run `npx -y --loglevel=error unitbob@0.4.5 run-local` once for the assembled
    branches. The connector owns the exact runner commands. A runner that never
    starts is a harness failure, not a red test. If the runner never started, it
    died before the first test or scenario; report its exact error, upload nothing
    for that branch, and do not build on that harness. A runner that starts and reaches production code may expose a
    real application failure. Application failures remain red. Let the lamp be red. Don't stop to repair the app before
    generating, and never weaken a check to get green.

    `run-local` also remembers each branch's set of failures between runs. When a
    branch comes back with exactly the set it came back with last time, it says
    so and exits non-zero: the edits since then changed nothing. That stops the
    branch, not one worker — the set belongs to the branch. Take it as the signal
    to look yourself, replan, or call the branch a `build_error`, never as a
    reason to run it again unchanged.

    Group the failures by the verbatim text of the error. Look yourself at any
    error that turns up under more than one worker: it is coordinator-owned. A
    host-owned shared step is yours, fixed once and never handed back;
    the connector-owned World is never locally patched. A World incompatibility
    missed by the pre-fan-out probe makes the behavioral branch a `build_error`.
    A production stack frame alone does not prove a product defect: incorrect
    generated setup can fail inside production. For owned-file failures, and for every
    valid checkpoint with `unresolved_promises`, create one narrow failure packet
    containing only its plan item, checkpoint, branch, owned paths and case markers,
    and related traces. A valid partial checkpoint with `unresolved_promises` enters
    repair even without an initial runner failure.

12. Launch one fresh named repair role per failure packet:
    `unitbob:suite-repair-worker` on Claude Code and `suite-repair-worker` on
    Codex. Run repair packets sequentially so they never share the project test DB.
    Each role completes `unresolved_promises` first while preserving finished files,
    then runs the same loop: `edit → run-local <branch> → inspect`. It may repeat
    that loop within its bounded incarnation. After each run it reads only cases
    matching its owned paths or case markers; it does not require a green exit code
    from the whole branch and never repairs foreign failures.

    The worker may read stack-referenced source, the actual runner setup and
    harness, helpers, and factories, but edits only owned generated files and its
    checkpoint. It inherits the checkpoint's facts rather than establishing them
    again. It never runs the project suite directly, changes production or
    shared harness, removes a case, marker, binding or assertion, adds
    `skip`/`pending`/`todo`, or weakens a business promise. A product defect handoff
    briefly names the violated business contract, reason, and production source
    references. There is no strict JSON handoff. Ambiguous owned failures, an
    unusable runner, unfinished promises, and `Stop` after a ceiling are
    `build_error`, never product red; this supersedes spec 40's ambiguous-red
    fallback. Shared harness that is still broken when you have run out of
    corrections to make is also `build_error` and has no repair feedback loop in
    this MVP.

    Preserve spec 35 after a repair ceiling: keep files and checkpoint, then ask
    `[Continue once / Stop]`; never auto-resume. After all sequential repair
    packets finish, run each affected branch exactly once as the final run.
    Confirmed production defects remain executable and red.

13. If behavioral is a `build_error`, skip review and keep the structural peer.
    Otherwise run
    `npx -y --loglevel=error unitbob@0.4.5 suite-review-prepare`. It runs and binds
    the exact candidate, then writes
    `.unitbob/suite-build/review-request.json`. That request includes the
    original behavioral assignment, its worker-plan items, and exact
    `plan_digest`, as well as the existing candidate and optional known-defect
    evidence.

14. There is always exactly one reviewer. Give that request and referenced suite
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

15. Run `npx -y --loglevel=error unitbob@0.4.5 put-suite-build` exactly once. It
    validates and publishes each branch independently, runs every branch it published,
    and prints the server summaries and map URL. Never ask the user
    to run the checks to finish generating.

Report publication only from upload lines and colors only from the server's run
summaries. Never turn a local build run into a claim about the map. Say plainly
when a peer was not published and why; red tests are live defects, not a failed
generation. Linking is automatic—never ask for or guess a repo id.
