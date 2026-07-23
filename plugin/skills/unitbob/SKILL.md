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
`npx -y --loglevel=error unitbob@0.1.11 <verb>`. It is
thin local hands — it runs tools and relays bytes to the Unitbob server. You
(Claude Code) do the map-building, suite-writing, and fixing locally, guided by
recipes the tool fetches from the server.

## Workflow

Each job is a file in `workflows/` next to this one. **Read the file and follow
it** — do not work from memory, and do not reach for a `/unitbob:...` command:
the file is the same thing the command runs, and it is here right now.

- **Rebuild the map** → `workflows/map.md`
- **Generate the guardrail suite** → `workflows/suite.md`
- **Run the checks** → `workflows/check.md`
- **Open the map** → `workflows/show.md`
- **Fix a red guard** (the code drifted) → `workflows/fix.md`

The `<guard_id>` for fix is the guard handle shown on the red lamp on the map —
the user copies it from there. To stop guarding code that is gone for good, the
user retires the guard with the button on the red lamp (no command, no workflow).

Map a natural-language request to the closest workflow. If it is ambiguous, ask
the user which one they mean rather than guessing destructively.

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
