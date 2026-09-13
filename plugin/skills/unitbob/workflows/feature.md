Record what the user is about to build or change — their `<intent>` below, in
their own words — as a Unitbob **feature**, together with the product
capabilities the work may touch. Nothing is edited and nothing is tested here:
this is the step *before* the change, so the user can see where to look, and
after the next check whether those places held. Your code never leaves the
machine.

Do this:
1. Run `npx -y --loglevel=error unitbob@0.7.12 feature-prepare`.
   It fetches the recipe and the product capabilities of the current map and
   writes `.unitbob/feature-start/request.json`. If it reports there is no
   current map, relay that message and stop — the map has to be built first
   (`workflows/map.md`), and only if the user asks for it.
2. Read `request.json` and the `recipe.text` inside it. Follow the recipe: the
   `<intent>` is what the user said in this conversation — do not ask them to
   restate it, do not shorten it. Reading code under the capabilities' addresses
   is allowed; editing anything is not.
3. Write your answer to the `output_path` the request names
   (`.unitbob/feature-start/feature.json`): `title`, `intent`, `affected`
   — the exact shape the recipe shows. An empty `affected` is a legitimate
   answer.
4. Run `npx -y --loglevel=error unitbob@0.7.12 put-feature`. It records the
   feature and prints the server's sentence and a link.
   If it answers 422 with `unknown_ids` and `known_ids`, correct `feature.json`
   using both lists — never invent an id — and run `put-feature` again.
5. Tell the user in **one short message**: the title, the affected capabilities
   by title with the one-line why for each (not ids, not the JSON), and the
   link `put-feature` printed. If the list is empty, say the server's sentence.
   If the project has no behavioural suite yet, add one line saying these
   capabilities are not guarded yet and the checks can be generated when the
   user is ready.
6. End that same message with one line offering the next step: "Want to talk
   it through now? I'd ask what I still need to know before anything is
   built." If the user says yes, continue in this session with
   `workflows/knowledge.md`, using the feature id — the number at the end of
   the link `put-feature` printed — so the lookup step is skipped. If not,
   stop here.

Do **not** ask questions along the way, do **not** start implementing, and do
**not** run any other Unitbob workflow on your own — the conversation about the
feature (offered in step 6) and the code come later, when the user asks.

Linking is automatic: if a command prints `Linked this project to Unitbob as X.`,
relay that line to the user verbatim. Never ask for or guess a repo_id.
