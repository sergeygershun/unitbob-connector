# Unitbob

A living map of your app's business parts. Each important seam gets an automatic
test — a "lamp" on the map. Green means fine, red means something broke.

Works with Ruby on Rails (RSpec), JavaScript/TypeScript (Vitest), and Python
(pytest) projects — the guardrail tests are generated in your project's own
language and run with its native test runner.

You work through a coding agent — Claude Code or Codex both work. You need:
Node 18+, Python 3.10+.

---

## Install (once)

**With a prompt:**
```
Add the Unitbob plugin marketplace: sergeygershun/unitbob-connector
Install the unitbob plugin
```

**With commands (in the terminal):**
```
claude plugin marketplace add sergeygershun/unitbob-connector
claude plugin install unitbob@unitbob
```

Restart the session so the commands load.

---

## Full cycle

Just type it in the chat. There is nothing to memorise and no command to get right.

| Step | Say this |
|------|----------|
| 1. Build the map | `Build my Unitbob map` |
| 2. Generate the tests | `Generate the guardrail tests` |
| 3. Fix a red lamp | `Fix guardrail <id>` |
| 4. Open the map | `Open my Unitbob map` |

Step 2 lights the lamps by itself: generating the tests also runs them and sends
the results. You do not have to ask for a run to see the first result.

Say `Run the checks` later, whenever you want the lamps refreshed against your
current code — or to finish the job if a generation was interrupted after the
tests were saved but before they ran.

In Claude Code there are also `/unitbob:map`, `/unitbob:suite` and friends, but
they work only in a terminal session started after the plugin was installed — in
a browser or desktop window they are not recognised at all. The phrasings above
work everywhere, so they are the ones documented here.

---

## How to read it

- **Green lamp** — the behavior works.
- **Red lamp** — something the structure relied on broke. Copy its `id` and run
  step 3.
- The project links itself by folder name — nothing to set up by hand.
