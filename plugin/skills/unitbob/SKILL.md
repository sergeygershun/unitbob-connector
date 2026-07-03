---
name: unitbob
description: Use when the user wants to map their app's business subsystems, generate or run guardrail tests that protect those subsystems, or open the Unitbob map — including natural-language phrasings like "rebuild the map", "what subsystems do I have", "generate guardrails", "run the checks", or "is anything broken".
---

# Unitbob

Unitbob turns a codebase into a living map of business subsystems, with each seam
between subsystems guarded by an auto-generated test. On the map, those tests show
as green or red lamps. A red lamp is the only signal the user needs: something the
structure depended on just broke.

There is a `unitbob` command-line tool, run via `npx unitbob@0.1.1 <verb>`. It is
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

## Setup

Each project links to Unitbob through a `.unitbob.json` file at its root, holding
`{ "server", "repo_id" }`. A project that has never used Unitbob won't have one.

**Before running any unitbob command in a project, check whether `.unitbob.json`
exists at the project root.** If it does not, set it up first — do not run the
command and let it fail with a scary error:

1. Tell the user plainly that this project isn't linked to Unitbob yet. This is
   normal first-time setup, not a failure.
2. Ask them for exactly two values: the **Unitbob server URL** and their
   **repo_id**. Never guess these, recall them from memory, or search the project
   for them — always ask the user.
3. Run `npx unitbob@0.1.1 init`, write the two values into `.unitbob.json`, then
   continue with what the user originally asked for.

If a command later reports a setup or config problem, surface it calmly and
re-check the two values with the user — don't treat it as a bug to debug.

## Important

Recipes (how to decompose, relate, and generate) are fetched from the server at
call time. **Never** copy recipe text into this skill or the project. Improving a
recipe is a server-side change only — that is what keeps this skill thin and stable.
