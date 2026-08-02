---
name: unitbob
description: Use when the user wants to map their app's business subsystems, generate or run guardrail tests that protect those subsystems, or open the Unitbob map — including natural-language phrasings like "rebuild the map", "what subsystems do I have", "generate guardrails", "run the checks", or "is anything broken".
---

# Unitbob

Unitbob turns a codebase into a living map of business subsystems, with each seam
between subsystems guarded by an auto-generated test. On the map, those tests show
as green or red lamps. A red lamp is the only signal the user needs: something the
structure depended on just broke.

There is a `unitbob` command-line tool, run via
`npx -y --loglevel=error unitbob@0.2.9 <verb>`. It is
thin local hands — it runs tools and relays bytes to the Unitbob server. You
(Claude Code) do the map-building, suite-writing, and fixing locally, guided by
recipes the tool fetches from the server.

## Workflow

Each job is a file in `workflows/` next to this one. **Read the file and follow
it** — do not work from memory, and do not reach for a `/unitbob:...` command:
the file is the same thing the command runs, and it is here right now.

- **Rebuild the map** → `workflows/map.md`
- **Generate the guardrail suite** → `workflows/suite.md` (this also runs the new
  suite and lights its lamps — there is no second step to ask for)
- **Run the checks** → `workflows/check.md` (later re-runs, and recovery if a
  generate run was interrupted)
- **Open the map** → `workflows/show.md`
- **Fix a red guard** (the code drifted) → `workflows/fix.md`

The `<guard_id>` for fix is the guard handle shown on the red lamp on the map —
the user copies it from there. To stop guarding code that is gone for good, the
user retires the guard with the button on the red lamp (no command, no workflow).

Map a natural-language request to the closest workflow. If it is ambiguous, ask
the user which one they mean rather than guessing destructively.

## How to talk to the user during the workflow

The person watching is a vibecoder, not an engineer. Every message spends their
attention, so keep the running commentary short and structured.

- **Don't dump generated files into the chat** — `.feature` files, step
  definitions, map JSON. They are written under `.unitbob/`; point at them, don't
  paste them.
- **Don't narrate your reasoning step by step** ("first I looked at…, then I
  filtered…, then I decided…"). That is a working trail for you, not something the
  user needs to read.
- **Don't echo raw tool output.** Say what it means in a line of your own.
- When you find something, say it as **one compact bullet**: what you found ·
  what it means · what you'll do about it.
- A checkpoint after a stage is **one or two lines**, not a page-long recap.
- End of a turn: what changed and what's next — not a retelling of what you did.

The point is the opposite of a wall of text. If a passage reads like an essay
about your reasoning, cut it.

## When to ask the user, and when to just decide

Most calls during map- and suite-building are technical and yours to make. Ask
the user **only** when a decision:

  (a) **changes their production code** — e.g. add back a gem you'd otherwise
      drop, edit `report.rb` to fix a real bug you found; or
  (b) **changes what gets built or run next** — e.g. write 18 failing scenarios
      now versus after a fix the user might want first.

Everything else you **decide yourself and report in one line** — don't open a
discussion for it. You decide: which graph edges are noise and get filtered,
which dead code to drop, how to group a fuzzy community, which fixture fields to
set, how to handle a locale or collation quirk in a test. State the call, move on.

When genuine (a)/(b) questions come up, **hold them and ask them together in one
checkpoint at the end** — never scatter them one at a time through the run. One
message with two clear questions beats six interruptions.

## Fewer approvals — allow the safe commands once

The workflow leans on a handful of read-only commands: searching the code,
checking dependencies, running the guardrail suite. Rather than have the user
approve each one every time, offer them this block for their
`.claude/settings.json` so they allow the whole set in a single paste:

```json
{
  "permissions": {
    "allow": [
      "Bash(grep:*)",
      "Bash(find:*)",
      "Bash(ls:*)",
      "Bash(cat:*)",
      "Bash(npx -y --loglevel=error unitbob@*)",
      "Bash(bundle check)",
      "Bash(bundle exec cucumber:*)",
      "Bash(bundle exec rspec:*)",
      "Read(//**/config/**)",
      "Read(//**/Gemfile*)",
      "Read(//**/package.json)",
      "Read(//**/db/schema.rb)"
    ]
  }
}
```

- The runner lines above are for a **Ruby/Rails** project. For
  **JavaScript/TypeScript**, swap them for `"Bash(npx vitest:*)"` and
  `"Bash(npx cucumber-js:*)"`; for **Python**, use `"Bash(python -m pytest:*)"`.
- Only **read-only** commands belong here. Anything that changes state —
  `bundle install`, `npm i`, `pip install`, `rails db:migrate`, `git push`,
  deploys — is deliberately left out, so it still asks first.
- If the user has the built-in **`fewer-permission-prompts`** skill, prefer it:
  it reads their own transcripts and proposes an allowlist automatically. The
  block above is the manual equivalent.

Working from these files is what makes unitbob usable everywhere. The
`/unitbob:...` commands are a convenience that exists only inside a Claude Code
terminal, and only in a session started after the plugin was installed — in a
browser or desktop window they do not register at all, and typing one comes back
as "Unknown command" or "isn't a recognized command here". So **never hand the
user a slash command**: ask them to say what they want in plain words ("run the
checks"), which reaches these same workflows in the session they already have
open. If a user reports one of those errors, explain that nothing is broken —
plain words work right now.

## Setup — linking is automatic

Each project links to Unitbob through a `.unitbob.json` file at its root. Nobody
creates or edits it by hand: if a project isn't linked yet, the connector
registers it on the server by its **folder name** and writes the file itself the
first time any unitbob command runs. There is no setup step.

- **Never ask the user for a server URL or a repo_id**, recall one from memory,
  or search the project or neighbouring folders for one. `repo_id` is an internal
  server key nobody is expected to know.
- When a command prints a line like `Linked this project to Unitbob as X.`, pass
  that one line through to the user **verbatim** — don't hide or embellish it.
  When no such line appears, the project was already linked; say nothing about
  linking.
- Run unitbob commands from the project's root folder (where `.git` or the
  project files like `Gemfile` are) — the connector refuses to link from
  anywhere else.
- If a command reports it cannot reach the Unitbob server, surface that calmly:
  the server isn't running — a prerequisite, not a bug to debug.
- If a command reports that `.unitbob.json` points at a different repo than the
  project's name resolves to, show that message as-is and let the user decide —
  never delete or rewrite the file on your own initiative.

## Building the map needs graphify

The `map` step uses a small local tool, `graphify`, to extract the code graph on
the user's machine (it runs locally and needs no API key). If `map` reports that
`graphify` is missing or not on PATH, **install it for the user and retry** — do
not just surface the error:

- Install with `pip install graphifyy && graphify install`. The PyPI package is
  `graphifyy` (two y's); the command stays `graphify`. It needs **Python 3.10+**.
- If Python 3.10+ isn't available, tell the user plainly that graphify needs
  Python 3.10+ and stop — don't guess another install path.

## Generating or running the suite needs a test runtime

The suite is real tests run on the user's machine, so the project's test
environment must work. Three rules:

- **Never scaffold a test setup** (`rails generate rspec:install` and friends) —
  unitbob brings its own boot file and writes it inside `.unitbob/` on every
  run. Nothing needs to be created or committed in the project.
- **The environment isn't ready** (dependencies not installed, test database
  not prepared) → fix it with the project's own standard commands (e.g.
  `bundle install`, `bin/rails db:test:prepare`) and retry. Changing a tracked
  file (like adding a gem to the Gemfile) needs the user's consent first —
  offer, don't just do it.
- **A server the environment depends on isn't running** (the database, the
  Unitbob server) → surface that calmly as a prerequisite — a message, not a
  debugging session.

## Important

Recipes (how to decompose, relate, and generate) are fetched from the server at
call time. **Never** copy recipe text into this skill or the project. Improving a
recipe is a server-side change only — that is what keeps this skill thin and stable.
