---
name: unitbob
description: Use when the user wants to map their app's business subsystems, generate or run guardrail tests that protect those subsystems, or open the Unitbob map — including natural-language phrasings like "rebuild the map", "what subsystems do I have", "generate guardrails", "run the checks", or "is anything broken".
---

# Unitbob

Unitbob turns a codebase into a living map of business subsystems, with each seam
between subsystems guarded by an auto-generated test. On the map, those tests show
as green or red lamps. A red lamp is the only signal the user needs: something the
structure depended on just broke.

There is a `unitbob` command-line tool, run via `npx unitbob@0.1.2 <verb>`. It is
thin local hands — it runs tools and relays bytes to the Unitbob server. You
(Claude Code) do the map-building, suite-writing, and fixing locally, guided by
recipes the tool fetches from the server.

## Workflow

- **Rebuild the map** → run `/unitbob:map`.
- **Generate the guardrail suite** → run `/unitbob:suite`.
- **Run the checks** → run `/unitbob:check`.
- **Open the map** → run `/unitbob:show`.
- **Fix a red guard** (the code drifted) → run `/unitbob:fix <guard_id>`.

The `<guard_id>` for fix is the guard handle shown on the red lamp on the map —
the user copies it from there. To stop guarding code that is gone for good, the
user retires the guard with the button on the red lamp (no command).

Map a natural-language request to the closest command. If it is ambiguous, ask the
user which one they mean rather than guessing destructively.

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
- Run unitbob commands from the project's root folder (where `.git` is) — the
  connector refuses to link from anywhere else.
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

## Important

Recipes (how to decompose, relate, and generate) are fetched from the server at
call time. **Never** copy recipe text into this skill or the project. Improving a
recipe is a server-side change only — that is what keeps this skill thin and stable.
