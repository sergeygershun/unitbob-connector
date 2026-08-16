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
npx -y unitbob@0.4.4 codex-install
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

---

## If your tests only run inside Docker

Some projects keep the code on this machine and everything that runs it — the
interpreter, the packages, the database — inside a container. Name that
container in `.unitbob.json` and Unitbob starts the project's own commands in
there:

```json
{ "server": "…", "repo_id": 3, "token": "…",
  "exec": { "docker": { "container": "myapp-web-1" } } }
```

Nothing else changes. Files are still read and written here, and the path inside
the container is worked out from the container's own mounts, so there is nothing
else to configure. Leave the field out and everything runs on this machine,
exactly as before.

The project folder has to be **mounted** into the container rather than copied
into the image — which it already is in any setup where you can edit a file and
see the change. If it is not, Unitbob says so and stops before writing anything.

Known limits of running in a container, all of them deliberate for now:

- **A run that times out can leave a process alive inside the container.** The
  timeout stops the `docker exec`, not necessarily what it started. A report
  such a process writes afterwards is never counted as a later run's result.
- **On a Linux host, files the container writes belong to `root`.** Unitbob does
  not map users: guessing there breaks images that installed their packages as a
  user of their own.
- **Only a container that is already running.** A project whose tests go through
  `docker compose run --rm` is not supported yet.
- **Review at a fixed revision is not supported with a container.** It works in
  a git worktree under the system's temporary directory, which is outside the
  mount. Ordinary review works in the project itself and is unaffected.
