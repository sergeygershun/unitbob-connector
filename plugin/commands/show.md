---
description: Open this project's Unitbob map.
---

Show the user where to view this project's map.

Do this:
1. `npx -y --loglevel=error unitbob@0.1.5 show` — this prints the link to the map on the server.

Give the user that link and invite them to open it. The map is viewed on the
server; the connector serves no UI of its own.

Linking is automatic: if a command prints `Linked this project to Unitbob as X.`,
relay that line to the user verbatim. Never ask for or guess a repo_id.
