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

0. **Check that this session can see the Unitbob roles, before you prepare
   anything.** Launch `unitbob:suite-reviewer` (Claude Code) or `suite-reviewer`
   (Codex) with one instruction: *answer with the single word READY; read
   nothing, write nothing, run nothing.* It takes seconds and touches no file.

   One role is checked, not four, and it is the reviewer on purpose: the other
   three you can stand in for — slower and worse, but the run finishes — and the
   reviewer you can never stand in for, so a session without it cannot publish
   the behavioral branch at all. Do not "improve" this into four checks: it is
   the same answer, bought four times.

   This check stands here as well as in `map.md`, because the map is often
   already built and the run then starts right here. On a2time, 2026-08-11, nine
   minutes fit between "generate the tests" and the first role launch — the
   preparation, the environment survey, the question to the user about scope, a
   plan of 18 workers and 18 seeded checkpoints — and all of it was spent before
   anyone found out the roles were not there.

   Ask again at step 7, immediately before fan-out, in the same one-word form.
   Not because this answer expires on its own, but because a run does not have to
   stay in one session: what step 7 launches is eighteen roles at once, and the
   check that guards it costs seconds. The Codex disk check at step 7 does not
   cover this — it looks at `~/.codex/agents/`, and files on disk are exactly
   what both lost runs had.

   If the host replies that there is no such agent type — `Agent type
   'unitbob:suite-reviewer' not found`, usually followed by the agents it does
   have — **stop here and say this**: the role definitions are on disk, but this
   session read its list of agents before they were installed, so it cannot see
   them. Restart the session (Claude Code) or open a new task (Codex), then run
   this again. Nothing on disk is lost and nothing has to be rebuilt.

   Any other failure means the role itself failed, not that the registry is
   missing it. Report that error as it stands and **do not** advise a restart: it
   will not help, and it costs the user everything else in the session.

1. Run `npx -y --loglevel=error unitbob@0.7.1 suite-prepare` with exactly one
   defect-context option. Use `--known-defect='<exact description>'` (and
   `--fixed-revision='<revision>'` when supplied), otherwise use
   `--no-known-defect`. This command checks the supported stack, provisions the
   runner, materializes the structural helper and connector-owned behavioral
   World, probes that World, and writes
   `.unitbob/suite-build/request.json`. **If it does not write that file, relay
   its message to the user as it stands and stop.** Do not work around a
   `fixable` profile failure or start fan-out without a request.

   It also clears the ground for this build: an earlier run's `worker-plan.json`,
   `checkpoints/` and `suite_output.json` are moved to
   `.unitbob/suite-build/previous/` and it says so. Nothing from a previous run
   is left where this one will look, and nothing was deleted — so never go
   hunting for leftovers to reconcile or remove, and never read `previous/` as if
   it belonged to this build.

   **The environment is never yours to repair.** Building an interpreter,
   installing the project's dependencies, pulling a base image, editing a
   `.ruby-version` or a lockfile — none of that is this workflow's work, and no
   failure turns it into it. On a2time, 2026-08-17, a run met a project pinned to
   a Ruby the machine did not have and set out to supply one: `rbenv install`,
   then a search for a base image, then a survey of which package hosts were
   reachable. It never ran this step at all, so nothing was generated, nothing
   was uploaded, and the user got a report about openssl instead of a suite.
   `suite-prepare` is the only thing that finds out what this machine can run.
   Whatever it answers, say it to the user in its own words and stop.

   **One of its answers is that the tests do not run on this machine.** A project
   whose interpreter, packages and database live in a container says so in
   `.unitbob.json`, and then every command that needs them runs in there:

   ```json
   "exec": {"docker": {"container": "myapp-web-1"}}
   ```

   Files stay on the host either way — only the processes travel — so nothing
   about the rest of this workflow changes. When `suite-prepare` cannot start the
   toolchain it lists the running containers that already have this project
   mounted and prints the line to add; add the one you run your tests in, and run
   the command again. Never write a container name it did not name: it is
   reporting what is actually running, and choosing between a `web` and a
   `worker` by their names is how a suite comes to run somewhere nobody meant it
   to.

2. Read `.unitbob/suite-build/request.json`. It names `project_root`,
   `output_path`, and the requested `branches`. Copy each branch's
   `runner_manifest` verbatim. Never invent or edit one and never add a branch
   absent from the request.

   The behavioral branch also carries `step_loading`, and it is the one thing a
   step file must get right to exist at all: `step_files` is the name pattern its
   runner will load — put the `capability_id` where the `*` is — and
   `requirements` is everything else that has to be true of a step file on this
   stack. Read it here and hand it to the workers. Do not look this up in the
   connector's source, and do not take it from memory: a step file the runner
   does not load raises nothing, contributes no scenarios, and comes back green.

3. Choose which lamps this build guards, before you plan anything, and choose
   for **both** branches in one message. The behavioral assignment lists every
   capability of the product map; the structural one lists every interface of
   every block. Scope is not about what fits in a worker — step 4 measures that,
   and it is rarely the binding constraint. It is about what is worth writing,
   running and repairing at all: on a2time, 2026-08-10, a build that took every
   capability gave one worker 8–11 of them, seven of eight workers wrote no file
   at all, and the run spent about 1.51M tokens on nothing.

   Read the behavioral assignment's capability list and propose the important
   ones, with a reason each in plain words. Judge from what the assignment
   already carries — `title`, `description`, and the `surfaces`, `tables` and
   `externals` lists. Money and access rights, many addresses, several external
   systems: those are readable signals. There is no weight formula and no target
   number of lamps. Propose what is worth guarding first, not how many workers it
   will take: how it divides is step 4's question and is measured, not judged.

   Do the same for the structural assignment, from the blocks and interfaces it
   already names. This branch used to be exempt — "it covers its whole
   assignment" — on the argument that its examples are cheap to run. They are;
   the assignment is not. On microblog, 2026-08-23, the answer narrowed the
   behavioral branch to eight lamps of fourteen and left all thirty-two
   interfaces in, so the question the user was asked reached eight of the
   fifteen workers that followed and the other seven were never put to them.

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

   Nothing records this choice except the plan you write next. The assignment
   stays exactly as the server sent it, and the publication line still counts
   against the whole map.

   The coverage manifest you write in step 9 stays exhaustive all the same, on
   both branches: every assigned capability and every assigned interface gets
   exactly one answer. What you guarded is `covered`; everything you left out is
   `unguarded` with a reason saying so in one plain sentence — "not in this
   build's scope; billing and access were guarded first" is a reason, "n/a" is
   not. An unguarded lamp is the honest state of something nobody guarded yet,
   and leaving it out of the manifest altogether is rejected at upload.

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
       "done_when": "all planned cases are written and checkpointed" }
   ] }
   ```

   Plan every requested branch over the lamps the user confirmed in step 3 and
   no others — the structural branch by the same rule as its peer, now that the
   question in step 3 covers both.

   **How many workers a branch gets is decided by how many cases they will
   write.** Not by how much source there is to read: on microblog, 2026-08-24,
   the branch with three times the source spent half the turns. A planned case
   is one intent somebody has to turn into a written example or Scenario, and
   what it costs in turns is a property of the branch — a Gherkin Scenario needs
   a World, a session, a fixture and an assertion; a structural example calls a
   method.

   There is a cheapest width, and **both sides of it are expensive.** An agent's
   cost is the sum of its context over its turns, so splitting pulls two ways:
   the opening context is bought once per worker and re-read every turn, while
   each conversation gets shorter, and a conversation costs with the square of
   its length. What the fifteen workers of that run would have cost at other
   widths:

   ```text
   workers     1      2      3      5      8     15     20
   input   51.2M  34.6M  29.9M  27.7M  28.8M  35.6M  41.3M
   ```

   Fifteen was 28% over the cheapest. One worker is 85% over it — and would have
   run a 216-turn worker into a 150-turn fuse. So there is no "as few as
   possible" here, and no "as many as the map lists" either.

   `accept-worker-plan` computes the cheapest width for each branch from the
   cases your plan intends, and refuses a plan outside a band around it. The
   bottom of that curve is flat, so the band is wide: anywhere inside it is
   within about a tenth of the cheapest. Nothing is copied into the plan to prove
   you did this — the cases are already in `planned_cases` and the width is
   already the length of the branch's slice list, so a field restating them would
   be two numbers copied by hand.

   The rule here used to be that there was no ceiling at all — that an agent
   re-reads its context every turn, so splitting never costs more than keeping
   the work together. True of the work, false of everything else a worker
   carries: 26,065 tokens of opening context on that run, the same to within
   ±370 across fifteen workers, and bought once per worker rather than divided
   between them.

   Never create an empty slice. Assign each planned capability exactly once and
   use globally unique worker ids and owned paths. Do not invent weights or a
   scheduler, and do not judge the width by how complicated the business looks:
   the only number is the measured one.

   A promise may have several planned behavioral scenario intents. Plan the
   scenarios the business outcome actually needs — no quota, in either
   direction. Route aliases and technical mirrors do not earn scenarios without
   a different business outcome. `surface_budget` is a ceiling, never a quota;
   unselected assigned surfaces are `deferred_surfaces`, not `unreachable`.

5. Run `npx -y --loglevel=error unitbob@0.7.1 accept-worker-plan`. If it exits
   non-zero, fix the whole reported batch and run it again. If it remains
   non-zero, stop before fan-out. The gate checks that the plan is intact —
   digests, ids, paths, capabilities that were actually assigned, and the
   `fan_out` of step 4 against the packets on disk — and no longer
   requires it to cover every capability in the assignment; that is what step 3
   decided. Do not replace this gate with a receipt, hook, or home-grown
   orchestrator.

   Accepting a plan also files what that plan implies: it writes
   `.unitbob/suite-build/checkpoints/<branch>-<worker-id>.json` for every slice,
   with the digests, the branch, the worker id, every assigned promise in
   `unresolved_promises`, and every other array the gate in step 8 checks. **Do
   not write those files yourself and do not correct their shape** — the side
   that checks the form is now the side that writes it, so a checkpoint refused
   over a missing empty array has stopped being possible. A checkpoint that
   already belongs to this plan is left exactly as it is, and the command says
   which ones those were.

   It also prints each worker's source packets and what they weigh. A source
   packet is the file behind one entrypoint, resolved from this machine's own
   `graphify-out/graph.json` and `.unitbob/map-build/surfaces.json` and copied by
   `suite-prepare` into `.unitbob/suite-build/packets/`. It has nothing to do
   with the failure and repair packets of steps 11-13. Keep that output: step 7
   hands each worker its own paths out of it. No packet is ever refused for being
   large, and no worker is refused work for carrying a lot of it — the sizes bind
   in exactly one place, the branch-wide `fan_out` of step 4, and never per
   worker. An entrypoint whose file was
   found but was too large to carry is printed as a path to open in place; one
   that resolved to nothing says so, and that worker searches as before. Both
   still count as work: the branch's total prices a file it could not carry at
   its real size, and an entrypoint nothing resolved at what the others average.

6. Add what you established about this project to the checkpoints step 5 seeded.
   That is the one thing in them no script can know, and it is the only thing in
   them that is yours to write. A seeded behavioral slice arrives with everything
   below already in it except the `facts` entry, which is what you are adding:

   ```json
   {
     "request_digest": "<exact>", "plan_digest": "<exact>",
     "branch": "behavioral", "worker_id": "w1",
     "unresolved_promises": ["<every assigned promise>"],
     "completed_promises": [], "written_paths": [],
     "decisions": [], "known_problems": [], "surface_coverage": [],
     "facts": [{"fact":"The route creates an order.","source_refs":["app/orders.rb:12"],"established_by":"read"}]
   }
   ```

   `decisions` and `known_problems` are arrays of short strings: what a worker
   chose, and what it knows is still wrong. Empty is a fine answer; absent is
   not — and getting that right is no longer your job. While the rule lived only
   inside the gate's own source, three runs in a row spent themselves on rejected
   checkpoints, about thirty of them on one run, which then got a hand-written
   normalizer to work around it. The gate's own side writes them now, so the
   whole class of refusal is gone.

   `surface_coverage` is the behavioral branch's fourth such array, and the shape
   above is a behavioral slice. Its workers fill it in as they write — one entry
   per Scenario, naming the addresses that Scenario actually drives — and step 9
   publishes exactly what they wrote. A structural slice is the same object
   without that key: the join is between Gherkin Scenarios and addresses, and the
   structural branch has no Scenarios.

   Everything every worker on the branch would otherwise discover alone belongs
   here: how a session is opened, which factory builds a paying customer, what
   the runner setup already does. On 2026-08-10 that list was assembled by hand
   halfway through the run, and the packets that received it finished
   completely.

   Every fact says how you established it: `"established_by": "read"` with the
   references you actually opened, or `"established_by": "ran: <command>"` when
   you ran that command in this session and read its output. **Nothing you
   remember about this project is a fact.** On a2time, 2026-08-17, nine facts
   established by running the application held all run and saved sixteen workers
   the same discoveries; the one written from memory — that a dismissed employee
   cannot sign in, one method confused with another — was false, and went to all
   sixteen packets marked as verified.

   When the facts are in, run
   `npx -y --loglevel=error unitbob@0.7.1 validate-worker-checkpoints` here,
   before fan-out. It is step 8's gate, it costs seconds, and it reads every
   checkpoint against the plan — so a fact it would refuse is refused now, rather
   than after sixteen workers have been launched on it. Skip it only if you added
   no facts at all: nothing else in those files came from you.

   If it refuses a seeded checkpoint for anything other than a fact you wrote,
   delete that one file and run `accept-worker-plan` again. Do not repair it by
   hand — the seed is the machine's to write, and hand-repairing it is how the
   normalizer above came to exist.

7. Use the same named role on both Claude Code and Codex: `unitbob:suite-worker`
   on Claude Code and `suite-worker` on Codex. For every plan item launch that
   role with only the plan item, the source packet paths step 5 printed for that
   worker, and referenced request paths. Paths, never contents: a packet pasted
   into a task is paid for again on every turn of your own context. The host-specific
   definition owns the cheaper model and the emergency turn fuse; never launch a
   generic subagent and never continue an exhausted context. Start a branch's
   workers together, in one go.
   Sequential slices save nothing and finish later.

   **In one go means one message.** All of a branch's workers are launched by a
   single message carrying one launch per slice — not by fifteen messages
   carrying one launch each. This rule has been here all along and both measured
   runs broke it the same way. On microblog, 2026-08-23, the fifteen launches
   went out one per turn and cost **3,543,510 tokens** between them: a turn
   re-reads your whole context, yours is the longest-lived context in the run,
   and fifteen launch turns is that context bought fifteen times over. It bought
   nothing — the workers ran concurrently either way, fourteen of them at once,
   sixty-two minutes of work inside ten minutes of clock.

   Then wait for the branch, not for each worker. Their returns arrive one at a
   time and each one hands you a turn; on that same run the fifteen return turns
   cost a further **3,573,675 tokens**. You cannot decline those turns, so make
   them cost nothing else: a slice that has come back needs no acknowledgement,
   no progress line and no inspection — its files are on disk and its checkpoint
   is written, and step 8 is what reads them. One report, once the branch is in.

   Before you launch them, repeat step 0's check — `unitbob:suite-reviewer` on
   Claude Code, `suite-reviewer` on Codex, one word back. This is the last point
   at which it is cheap: past it, eighteen roles start at once, and a session
   that has changed since step 0 loses all of their work. Same two answers as
   before: not found in the registry means restart the session or open a new
   task; anything else means the role itself broke, and a restart will not help.

   On Codex, the Unitbob definitions must also be discoverable on disk in
   `~/.codex/agents/`; if they are missing, stop and run
   `npx -y --loglevel=error unitbob@0.7.1 codex-install`, then tell the user to
   start a new Codex thread. That is a different question from the one above —
   files on disk are exactly what both lost runs already had — so ask both. No Codex version is currently qualified by Unitbob
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
   promise. Their source packets are the starting point of that looking, not an
   extra place to check: whatever is in a packet has already been found. A worker
   whose line in step 5 said "no packets" searches the way workers did before it.
   Ask closed questions with the files to look in. They may ask the
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

8. Run `npx -y --loglevel=error unitbob@0.7.1 validate-worker-checkpoints` after
   fan-out and before assembly or repair. It verifies one compact checkpoint per
   plan item against the exact request and plan digests, worker id, promises,
   and owned paths. A stale or invalid checkpoint never goes to repair: record a
   `build_error` for that branch and continue its peer.

9. List each valid branch's files and write its answer. **Do not merge files.**
   The suite is the set of files the workers wrote: name every one of them and
   let the bytes stand. Concatenating slices into one file, staging them outside
   the branch root for later collection, or writing a script that glues them
   together are all the same mistake — on 2026-08-12 that path produced a
   `parts/` directory placed deliberately out of the runner's reach and an
   `assemble.sh` that then needed protecting from step 13 of this very workflow.
   The server stores exact bytes and never assembles; neither do you.

   Do this without rereading the whole source tree. Follow each server recipe and
   preserve every opaque id, `contract_key`, and `case_marker`. Structural
   examples exercise production code and assert an observable outcome.
   Behavioral Given/When/Then steps drive real public behavior. Workers do not
   edit `.unitbob/behavioral/step_definitions/00_unitbob_world.rb`, copy its
   contents, or use `render_template`; use only the World's status and redirect
   API. Application and FactoryBot-specific login/domain setup belongs in
   host-owned shared steps.

   `test_metadata` comes from the checkpoints step 8 accepted, not from the files
   and not from what a worker said about its work: a capability is `covered` when
   its slice completed the promises and wrote the cases, and its
   `surface_coverage` is that slice's entries for that `capability_id`, each one
   copied through as `{scenario, surfaces}` — the id groups them and does not
   travel. **Never search the generated files for a marker to decide any of
   this.** On a2time, 2026-08-17, the coordinator wrote itself a check that
   looked for the marker anywhere in the file text, so a marker sitting in a
   comment that explained why an interface was *not* covered counted as coverage,
   and `usage_export` went up `covered` with nothing exercising it. The behavioral
   server catches that at publish, because it parses Gherkin and reads tags; the
   structural server deliberately does not, and a green lamp with nothing behind
   it is the one outcome this entire workflow exists to prevent.

   Everything the plan never took has no checkpoint at all, and that is where its
   answer comes from: no slice, no checkpoint, therefore `unguarded`, with the
   reason step 3 already settled. This is the only entry in the manifest whose
   source is the plan rather than a checkpoint, and since step 3 now narrows both
   branches it exists on both. Do not go looking for a checkpoint that was never
   seeded, and do not leave the entry out — the upload refuses a manifest that
   answers for fewer than every assigned id.

   Write strict JSON only to the request's `output_path`, one entry for every
   requested branch. Each branch names one main file and every other file it
   owns in `support_files` — several `.feature` files, several structural slices,
   step definitions and helpers alike:

   ```json
   { "branches": [
     { "suite_kind": "structural",
       "suite_file": { "path": ".unitbob/structural/billing_spec.rb",
         "support_files": [{ "path": ".unitbob/structural/reporting_spec.rb" }] },
       "runner_manifest": "<verbatim request object>",
       "test_metadata": { "capabilities": [] } },
     { "suite_kind": "behavioral",
       "suite_file": { "path": ".unitbob/behavioral/features/billing.feature",
         "support_files": [
           { "path": ".unitbob/behavioral/features/reporting.feature" },
           { "path": ".unitbob/behavioral/step_definitions/business_steps.rb" }
         ] },
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

10. Run `npx -y --loglevel=error unitbob@0.7.1 validate-build` after assembly. It
    checks locally only what the server cannot see — that the files the answer
    names exist under `.unitbob/`, and that every branch the request asked for
    has an entry — and then sends the exact batch the publish would send as a
    **dry run**: the same server, the same validation, nothing stored. What it
    prints back is the server's own verdict, word for word, so there is nothing
    to interpret and nothing that can disagree with the real publish later.

    It costs one request, so correct a whole reported batch and ask again —
    seconds, not another run and review. Workers do not repeat any of this
    locally. With no network it still succeeds, and names what went unchecked.

    Run it again after step 14. Until the review exists this command sends the
    behavioral branch without it and says so; the second run is the one that gets
    a verdict on the whole branch, and it is the cheapest possible insurance for
    the single publication step 15 allows.

11. Run `npx -y --loglevel=error unitbob@0.7.1 run-local` once for the assembled
    branches. The connector owns the exact runner commands. A runner that never
    starts is a harness failure, not a red test. If the runner never started, it
    died before the first test or scenario; report its exact error, upload nothing
    for that branch, and do not build on that harness. A runner that starts and reaches production code may expose a
    real application failure. Application failures remain red. Let the lamp be red. Don't stop to repair the app before
    generating, and never weaken a check to get green.

    A red `run-local` reads its own report out: every failed case with its name,
    its file, the step it broke on where the runner has steps, and the error
    text. **Never parse `pytest_bdd_report.json`, `pytest_result.xml` or any
    other report file yourself, and never grep the step definitions to find out
    which one failed.** The connector wrote those files and knows their shape; on
    the microblog bench the repair stretch cost 79 coordinator turns and 47% of
    the coordinator's input tokens, much of it inline `node -e` and `python3`
    re-reading files this command has already read. If the read-out leaves one
    thing unexplained — which factory, which signature, which role an endpoint
    permits — send that one closed question to `unitbob:fact-finder` with the
    files to look in, and read its answer. Deciding what the failures mean, and
    who owns each of them, stays yours; finding the text they refer to does not.

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
    `build_error`, never product red; this supersedes spec 42's ambiguous-red
    fallback. Shared harness that is still broken when you have run out of
    corrections to make is also `build_error` and has no repair feedback loop in
    this MVP.

    Name each packet out loud, because sequential repair is silent for a long
    time: one packet is tens of minutes during which a blocking worker prints
    nothing, and five of those in a row are indistinguishable from a hung
    process. Print one line before launching a packet and one line after it
    returns:

    ```text
    repair 3/7: bh-agency-solo-sales
    repair 3/7: bh-agency-solo-sales — 48 scenarios green
    ```

    The number after the slash is the count of failure packets you actually
    built, and the outcome is a few words: green, still red, handed off as a
    product defect, stopped at a ceiling. No progress bar, no timer, no estimate
    of what is left, and nothing written to a file — the sequence is already in
    your hands, and this only says it.

    Preserve spec 35 after a repair ceiling: keep files and checkpoint, then ask
    `[Continue once / Stop]`; never auto-resume. After all sequential repair
    packets finish, run each affected branch exactly once as the final run.
    Confirmed production defects remain executable and red.

13. If behavioral is a `build_error`, skip review and keep the structural peer.
    Otherwise run
    `npx -y --loglevel=error unitbob@0.7.1 suite-review-prepare`. It runs and binds
    the exact candidate, then writes
    `.unitbob/suite-build/review-request.json`. That request includes the
    original behavioral assignment, its worker-plan items, and exact
    `plan_digest`, as well as the existing candidate and optional known-defect
    evidence.

14. There is always exactly one reviewer, and it is a named role, like the other
    three: `unitbob:suite-reviewer` on Claude Code and `suite-reviewer` on Codex.
    Launch that independent reviewer in a fresh context with the review request
    and the suite it references. If one is unavailable, do not upload the
    behavioral branch. The role carries the review schema, so nothing here has to
    recite it from memory — a schema written from memory is what cost three runs
    out of four their publish.
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

    **What a Scenario objection does, so that nobody goes looking for a way
    around it.** A capability whose Scenarios were *all* objected to is stored
    `unguarded` at publish, with the objection as the reason its owner reads. One
    objection among sound siblings changes nothing, and a
    `pass_with_reservation` never downgrades anything. The publish still goes
    through, no repair round opens, and the single upload in step 15 is
    unaffected — so an objection costs this run nothing. Never edit a verdict to
    avoid it: an objection recorded is the only thing standing between a Scenario
    that checks nothing and a green light telling the owner their feature is
    protected. Run `validate-build` once more after this step to get the server's
    verdict on the whole branch, review included.

15. Run `npx -y --loglevel=error unitbob@0.7.1 put-suite-build` exactly once. It
    validates and publishes each branch independently, runs every branch it published,
    and prints the server summaries and map URL. Never ask the user
    to run the checks to finish generating.

Report publication only from upload lines and colors only from the server's run
summaries. Never turn a local build run into a claim about the map. Say plainly
when a peer was not published and why; red tests are live defects, not a failed
generation. Linking is automatic—never ask for or guess a repo id.
