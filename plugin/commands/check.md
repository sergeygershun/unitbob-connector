---
description: Run the guardrail suite and report which subsystems are green or red.
---

Run the guardrail suite for this project and report the result.

Do this:
1. `npx -y --loglevel=error unitbob@0.1.8 run` — this fetches the current suite, runs it locally, and ships
   the raw result to the server, which returns the run summary.

Then report the summary to the user in plain business language: which subsystems
are healthy (green) and which broke (red), and for a red one, what business
behaviour the broken seam protected. Print the server's summary as-is; do not
re-interpret raw test output yourself.

If the summary begins with `Unitbob could not run the architecture checks:`, that
is the server's own answer — the suite ran but its result could not be joined to
the map (e.g. the run and the stored suite drifted apart). Relay that message
verbatim; do not claim the run endpoint is missing or unimplemented, and do not
invent a cause. If it persists, regenerating the suite (`/unitbob:suite`) is the
fix.

Linking is automatic: if a command prints `Linked this project to Unitbob as X.`,
relay that line to the user verbatim. Never ask for or guess a repo_id.
