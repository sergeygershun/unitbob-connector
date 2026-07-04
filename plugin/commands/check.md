---
description: Run the guardrail suite and report which subsystems are green or red.
---

Run the guardrail suite for this project and report the result.

Do this:
1. `npx -y --loglevel=error unitbob@0.1.5 run` — this fetches the current suite, runs it locally, and ships
   the raw result to the server, which returns the run summary. (capability lands
   in spec 18)

Then report the summary to the user in plain business language: which subsystems
are healthy (green) and which broke (red), and for a red one, what business
behaviour the broken seam protected. Print the server's summary as-is; do not
re-interpret raw test output yourself.

Linking is automatic: if a command prints `Linked this project to Unitbob as X.`,
relay that line to the user verbatim. Never ask for or guess a repo_id.
