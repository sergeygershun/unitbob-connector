Write the checks for a feature that has been talked through: make the
scenarios of its `knowledge.md` executable, so that they run red today and
turn green only when the feature is built. The scenario text is the user's and
is sealed on the server; you write the wiring around it — step definitions and
metadata — and nothing of the feature itself.

Do this:
1. If you do not already know the feature's id from this session, run
   `npx -y --loglevel=error unitbob@0.7.11 knowledge-prepare` with no argument
   and pick the feature the user's words point at from the list (ask only if
   two titles could both be meant). The feature has to be talked through first
   (`workflows/knowledge.md`); if `tests-prepare` below answers 409 with the
   server's sentence, relay it and stop.
2. Run `npx -y --loglevel=error unitbob@0.7.11 tests-prepare <id>`. It fetches
   the feature's assignment and the recipe, checks `knowledge.md` on disk
   against the server, puts the main suite and every feature's checks on disk
   under `.unitbob/behavioral/`, provisions the runner, and writes
   `.unitbob/features/<id>/tests-request.json`. If it stops with a message,
   print it to the user and stop: it is the server's own instruction.
3. Read `tests-request.json` and the `recipe.text` inside it, and follow the
   recipe exactly. In short: write one `.feature` at `feature_path` with the
   `scenarios` from the request copied **word for word** — names, steps,
   order — and two tags over each (the assignment's `case_marker` and the
   `feature_tag`), the `@source_*` tag carried over; write the step
   definitions at `steps_path`, reusing the main suite's shared steps
   (`main_suite.paths`) rather than defining them again, and editing none of
   the main suite's files; write `test_metadata` with the one capability from
   the assignment as it is and `surfaces: []` per scenario.
4. Run `npx -y --loglevel=error unitbob@0.7.11 run-local --feature <id>` and
   fix **the wiring only** — undefined, ambiguous (delete your duplicate),
   pending steps, data setup — until **every scenario fails**, best on its
   Then or When; a Given may fail when the data the feature needs does not
   exist yet. If a scenario passes on today's code, stop and tell the user:
   either it already exists or the check proves nothing, and that is their
   call, through a new talk — never an edit to the scenario.
5. Write `tests-output.json` at the request's `output_path` — `suite_file`
   with the two paths, `runner_manifest` from the request, `test_metadata` —
   then run `npx -y --loglevel=error unitbob@0.7.11 put-tests <id>`. It runs
   the checks itself, sends them with that run as the proof of red, and prints
   the server's sentence and a link.
   If it answers 422, the output names what is wrong — for a broken seal one
   `expected:` / `got:` pair per difference. Fix the `.feature` or the wiring
   from those lines and run `put-tests` again. Go back to the user only for a
   scenario that passes or a `knowledge.md` that changed (409).
6. Tell the user in **one short message**: the server's sentence (how many
   checks, all red) and the link `put-tests` printed. No file contents, no
   plan for the code.

Do **not** write a line of the feature's implementation, not even a stub — the
checks have to fail because the behaviour is missing. Do **not** touch any
tracked file, do **not** reword, drop or add a scenario, do **not** run the
independent reviewer, and do **not** run any other Unitbob workflow on your
own. Building the feature is the user's next conversation, not this one.

Linking is automatic: if a command prints `Linked this project to Unitbob as X.`,
relay that line to the user verbatim. Never ask for or guess a repo_id.
