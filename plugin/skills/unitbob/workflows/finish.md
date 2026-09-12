Wrap up a feature the user says is done. "Done" is not your word and not the
user's: it is the server's, and it means every check of the feature passes,
the checks have been reviewed, and nothing the feature touched is red. This
workflow gets the feature to the point where the server says so, and then
hands the user the page where they press **Finish** themselves. Nothing here
marks a feature finished, and nothing here argues with a red result.

Do this:
1. If you do not already know the feature's id from this session, run
   `npx -y --loglevel=error unitbob@0.7.12 knowledge-prepare` with no argument
   and pick the feature the user's words point at from the list (ask only if
   two titles could both be meant).
2. Run `npx -y --loglevel=error unitbob@0.7.12 run`. It runs the application's
   guardrails and, after them, the feature's own checks, and prints one line
   per feature from the server. Read the line for this feature:
   - **"…: all N checks pass — review them to unlock Finish."** — go to step 3.
   - **"…: all N checks pass, reviewed — press Finish on the feature page."**
     — go to step 5.
   - **"…: K of N checks pass."** or any red line about the application —
     go to step 6.
   - **"…: Unitbob could not run the feature’s checks — …"** — relay the
     line as it is and stop; do not invent a cause.
   If it stops before running with "The checks for “…” changed on disk since
   they were saved", run `npx -y --loglevel=error unitbob@0.7.12 put-tests <id>`
   to save them, then run this step again.
3. Run `npx -y --loglevel=error unitbob@0.7.12 tests-review-prepare <id>`. It
   writes `.unitbob/features/<id>/tests-review-request.json`: the checks as
   they will be uploaded, their `candidate_digest`, the one capability the
   feature is, `knowledge_path` (where the promises are written), the sealed
   `scenarios`, and `output_path`. If it answers 409 with the server's
   sentence, relay it and stop.
4. Launch the independent `suite-reviewer` agent on that request — it reads
   the request, the `.feature` file and the step definitions behind it, and
   writes `bdd_quality_review` to `.unitbob/features/<id>/tests-review-output.json`.
   Do not review the checks yourself, and do not edit them. Then run
   `npx -y --loglevel=error unitbob@0.7.12 put-tests <id>`: it runs the
   checks again, sends the review bound to them, files the run, and prints the
   server's line for the feature. If that line now says "reviewed — press
   Finish on the feature page", go to step 5. If `put-tests` answers 422 with
   the server's words about the review, hand those words back to the reviewer
   and run `put-tests` again — never rewrite a verdict yourself.
5. Tell the user in **one line**, with the link `put-tests` or `run` printed:
   "All N checks pass and are reviewed — press Finish on the feature page."
   Then stop. The button is the user's, on purpose.
6. Something is red. Print the server's lines as they are, in plain business
   language, and offer the way forward — do not talk the user past it:
   - A red lamp of the application (a guardrail the feature broke): the fix
     or the accept goes through `workflows/fix.md`, with the handle from the
     red lamp on the map. A promise the user said must keep working is a fix;
     a change they planned is an accept.
   - The feature's own checks still failing: run
     `npx -y --loglevel=error unitbob@0.7.12 contract-prompt feature:<id> feature_<id> fix`.
     It prints the same brief the feature page shows under **Fix this** —
     the failing scenarios in the words of `knowledge.md`, and the rule that
     the checks are not the thing to change. Take it as the brief and fix the
     feature's code; then run this workflow again.
   Never finish "for now", never vouch for a red result in words, and never
   accept a change in chat instead of on the map.

Do **not** touch the scenarios or the checks' text — they are sealed. Do
**not** run the reviewer before the server's line asks for it: a review of
checks that are not all green is refused. Do **not** press, simulate or
describe the Finish button as pressed; it is a page, and the user's.

Linking is automatic: if a command prints `Linked this project to Unitbob as X.`,
relay that line to the user verbatim. Never ask for or guess a repo_id.
