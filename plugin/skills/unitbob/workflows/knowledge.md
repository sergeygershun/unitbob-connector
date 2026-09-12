Talk a recorded feature through with the user, in their product language, and
write down what "done" means — as `knowledge.md`, the one file the tests will
later be written from. Nothing is implemented here and nothing is tested; the
code never leaves the machine. The conversation is in the user's language; the
file is in English.

Do this:
1. If you do not already know the feature's id from this session, run
   `npx -y --loglevel=error unitbob@0.7.11 knowledge-prepare` with no argument.
   It prints one line per feature that can be talked through: `<id>  <title>
   (<status>)`. Pick the one the user's words point at. If two titles could
   both be meant, ask which — this is the only question about identity, and
   the only one that is not about the business. If it prints the server's
   sentence that there is no feature to talk through yet, relay it and stop:
   the feature has to be recorded first (`workflows/feature.md`), and only
   if the user asks for it.
2. Run `npx -y --loglevel=error unitbob@0.7.11 knowledge-prepare <id>`. It
   fetches the recipe and the feature's packet and writes
   `.unitbob/features/<id>/request.json`.
3. Read `request.json` and the `recipe.text` inside it, and follow the recipe
   exactly. In short: draft your understanding first and mark every
   assumption; ask in rounds — the whole frontier at once, each question
   numbered, with options and your recommendation, in the user's product
   language, never about code; at most five questions a round and three
   rounds, then close what is left with your recommendations and say so;
   facts you look up yourself, decisions the user makes. Reading the
   project's code and the folders the request names is allowed; editing is
   not. Do not show the draft — only the questions.
4. When nothing is left open, show the user **one message**: the scenarios
   exactly as they will be in the file (name and Given/When/Then, in
   English — with one line in the user's language under each if the
   conversation is not in English), the decisions on existing promises, and
   what is out of scope. Ask one question: "Is this what done means?"
   Corrections are answers — fold them in and show the summary again.
5. Only on an explicit "yes": write `knowledge.md` to the `output_path` the
   request names, in the exact shape the recipe shows, then run
   `npx -y --loglevel=error unitbob@0.7.11 put-knowledge <id>`. It records the
   file and prints the server's sentence and a link.
   If it answers 422, the output has one `expected:` / `got:` pair per problem.
   Fix the file from those lines — sections, Gherkin, tags, promise lines —
   without going back to the user, and run `put-knowledge` again. Go back to
   the user only for an open assumption you missed.
6. Tell the user in **one short message**: the server's sentence (how many
   scenarios, how many promises will change) and the link `put-knowledge`
   printed. No retelling of the conversation, no file contents. End with one
   line offering the next step: "Want me to write the checks now?" — and if
   the user agrees, continue with `workflows/tests.md`, with this feature's
   id already known.

Do **not** upload without the user's "yes", do **not** start implementing, and
do **not** run any other Unitbob workflow on your own — the checks are written
from this file only when the user asks, and the tests workflow is the one
step this one may hand over to.

Linking is automatic: if a command prints `Linked this project to Unitbob as X.`,
relay that line to the user verbatim. Never ask for or guess a repo_id.
