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

**Claude Code (in the terminal):**
```
claude plugin marketplace add sergeygershun/unitbob-connector
claude plugin install unitbob@unitbob
```

**Codex (in the terminal):**
```
codex plugin marketplace add sergeygershun/unitbob-connector
codex plugin add unitbob@unitbob
npx -y unitbob@0.4.1 codex-install
```

Start a new Claude Code or Codex thread so the installed skill and named agents
load. After setup, the phrasings and Unitbob flow below are the same on both
hosts.

Codex compatibility: version 0.145.0 accepts the Unitbob custom-agent TOML files,
but its experimental rollout budget is shared by the root and subagents rather
than enforced separately for each named agent. No Codex version is currently
qualified by Unitbob for a native per-agent ceiling. Before the first bounded
role, Unitbob therefore asks whether to continue this invocation without that
mechanical ceiling; approval is never persisted. The definitions keep the native
budget values so a future Codex release can be qualified without introducing a
Unitbob supervisor.

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

### If the assistant says it cannot find the Unitbob instructions

A session that started *before* the plugin was installed does not pick up the
skill, so the assistant has nothing to follow. Restarting the session is the
clean fix. If that is inconvenient, the instructions are ordinary files on disk
and the assistant can read them directly — tell it:

```
Read ~/.claude/plugins/cache/unitbob/unitbob/<version>/skills/unitbob/SKILL.md
and follow the workflow it names for this job.
```

`<version>` is whatever `claude plugin list` reports (for example `0.3.2`). The
workflow files sit next to it under `workflows/`, one per job, and each is
self-contained — that is what they are designed for.

---

## How to read it

- **Green lamp** — the behavior works.
- **Red lamp** — something the structure relied on broke. Copy its `id` and run
  step 3.
- The project links itself by folder name — nothing to set up by hand.
