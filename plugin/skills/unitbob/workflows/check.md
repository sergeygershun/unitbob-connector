Run every Unitbob contract suite for this project and report the result.

Do this:
1. `npx -y --loglevel=error unitbob@0.3.4 run` — this fetches both current
   suites (structural and behavioral), runs each `ready` one locally with its own
   runner (RSpec/Vitest/pytest for structural; `cucumber`/`@cucumber/cucumber`/
   `pytest-bdd` for behavioral — the connector picks the command, nothing to
   configure), and ships both raw machine-readable reports to the server, which
   returns one summary per contract system. Each branch is independent: one
   branch's runner error never stops the other, and check never installs
   anything. If a branch's stack does not match, that branch reports a suite
   error and the other still runs — regenerate the suites by following
   `suite.md` next to this file.

Then report both summaries to the user in plain business language: on each map,
which subsystems are healthy (green) and which broke (red), and for a red one,
what business behaviour the broken seam protected. Print the server's summaries
as-is; do not re-interpret raw test output yourself.

If a summary begins with `Unitbob could not run the …:`, that is the server's own
answer — the suite ran but its result could not be joined to the map (e.g. the
run and the stored suite drifted apart). Relay it verbatim; do not claim an
endpoint is missing, and do not invent a cause. If it persists, regenerating the
suites (follow `suite.md` next to this file) is the fix.

Linking is automatic: if a command prints `Linked this project to Unitbob as X.`,
relay that line to the user verbatim. Never ask for or guess a repo_id.
