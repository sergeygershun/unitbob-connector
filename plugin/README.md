# Unitbob for Claude Code

Unitbob adds Claude Code commands that build and check a business map for your app.
Your source stays on your machine. Claude Code reads local files, writes local
outputs, and the `unitbob` connector sends only generated map, suite, and run
artifacts to the Unitbob server.

## Install

Prerequisites:

- Claude Code with plugin support.
- Node.js 18 or newer.
- Access to the Unitbob server and a `repo_id` for your project.
- For Rails guardrails: Rails + RSpec with `spec/rails_helper.rb` working.

First check that the published connector works on this machine:

```bash
npx unitbob@0.1.1 --help
```

Then add the marketplace and install the plugin. The marketplace lives in the
**public** `unitbob-connector` repo, so no GitHub sign-in or access grant is
needed.

**In Claude Code** (interactive terminal), type:

```text
/plugin marketplace add sergeygershun/unitbob-connector
/plugin install unitbob@unitbob
```

**If `/plugin` is not available in your environment** (some IDE/embedded sessions
report `/plugin isn't available in this environment`), run the equivalent from a
terminal instead:

```bash
claude plugin marketplace add sergeygershun/unitbob-connector
claude plugin install unitbob@unitbob
```

Both install at `user` scope. After installing, **start a new Claude Code
session** so the `/unitbob:*` commands and the skill load — they do not appear in
the session that ran the install. Confirm it is enabled with:

```bash
claude plugin list        # expect: unitbob@unitbob … Status: ✔ enabled
```

## Project Setup

Open Claude Code in the root of the project you want Unitbob to protect.

You normally do **not** create the config by hand. Just run a command (e.g.
`/unitbob:map`) or ask in plain language ("build the map"). If the project is not
linked yet, the command stops with a setup message; Claude Code then runs
`npx unitbob@0.1.1 init` for you and asks for the two values it needs — the
server URL and your `repo_id`. You only supply those; the agent runs the tool.

The result is a `.unitbob.json` at the project root (git-ignored):

```json
{
  "server": "https://your-unitbob-server.example.com",
  "repo_id": 123
}
```

For a locally running server use `"server": "http://localhost:3000"`. Then check
the connection:

```text
/unitbob:show
```

If setup fails, check that `.unitbob.json` is in the project root and that
`repo_id` is a number, not a string.

You never open a terminal for the workflow itself: Claude Code runs every
`npx unitbob …` call through its own tools — you just chat and approve.

## Workflow

Run these commands from Claude Code:

```text
/unitbob:map
/unitbob:suite
/unitbob:check
```

Use `/unitbob:map` to rebuild the business map, `/unitbob:suite` to generate the
local RSpec guardrail suite, and `/unitbob:check` after code changes.

When the map shows a red guard, copy its guard handle and run:

```text
/unitbob:fix <guard_id>
```

Claude Code will fetch the focused repair packet, edit local application code,
and then ask you to run `/unitbob:check` again.

## What Gets Sent

Unitbob does not upload your source tree. The connector sends generated graph/map
documents, generated guardrail specs and metadata, and raw guardrail run results.
