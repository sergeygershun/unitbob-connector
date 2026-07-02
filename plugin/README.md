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

In Claude Code, add the marketplace and install the plugin:

```text
/plugin marketplace add sergeygershun/unitbob
/plugin install unitbob@unitbob
/reload-plugins
```

If the repository is private, sign in to GitHub first with `gh auth login` or set
up SSH access so Claude Code can clone it. If you do not have access to the
private repository, ask the Unitbob maintainer to invite your GitHub account or
publish the plugin marketplace from a public repository.

## Project Setup

Open Claude Code in the root of the project you want Unitbob to protect.

If `.unitbob.json` does not exist, run:

```bash
npx unitbob@0.1.1 init
```

Fill in the generated file:

```json
{
  "server": "https://your-unitbob-server.example.com",
  "repo_id": 123
}
```

Then check the connection:

```text
/unitbob:show
```

If setup fails, check that `.unitbob.json` is in the project root and that
`repo_id` is a number, not a string.

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
