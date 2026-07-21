Rebuild the architecture map for this project.

Do this:
1. Run `npx -y --loglevel=error unitbob@0.1.10 map-prepare`. It refreshes the code
   graph and writes the build request.
2. Read `.unitbob/map-build/request.json`. It gives you `project_root`,
   `graph_path`, `output_path`, and the fetched recipes.
3. Read the graph at `graph_path`. **This is your input — the whole map is built
   from it.**
4. Build the map locally from what the graph shows.
5. Run `npx -y --loglevel=error unitbob@0.1.10 put-map-build`.

## Reading the graph (step 3)

The graph is one JSON file, tens of thousands of lines long. **Project it with a
command, never with a file-reading tool** — a plain read truncates it and leaves
you with an arbitrary fragment. The recipes carry the commands and explain what
the nodes and edges mean; follow them rather than inventing your own view. They
use `node`, which is already on this machine because the unitbob command line
runs on it — do not reach for another tool that may not be installed.

**Do not substitute anything for the graph.** `GRAPH_REPORT.md`, `graph.html`,
and `manifest.json` in `graphify-out/` are graphify's human-facing outputs, not
your input: they summarise the graph with exactly the detail you need stripped
out. Reading the project's source files instead of the graph is the same mistake
in slower form — open a source file only to settle one specific thing the graph
left ambiguous, never as the way to discover what the subsystems are.

If the graph still looks like somebody else's code (top communities full of
library files, `_()` and `$()` as the busiest nodes), the extraction predates the
noise filter. Re-run `map-prepare` — it rewrites `.graphifyignore` before
extracting, and third-party and generated paths drop out.

## Building the map (step 4)

- The code never leaves the machine: everything you read stays under
  `project_root`, and the only thing that goes anywhere is the finished map.
- Use the fetched `recipes.decompose.text` and `recipes.relate.text`.
- Run the work in this order: Decompose, prepare relationship input, Relate,
  merge final map document.
- Omit uncertain blocks or relationships instead of inventing them.
- Produce Map Document `version` as the JSON integer `3` (not the string `"3"`
  and not a recipe-internal format tag like `"map/1"`), with `summary`,
  `blocks`, `external_systems`, `data_stores`, and `relationships`.
- Every relationship `source`, `target`, and `related_interfaces[]` entry must
  refer to ids present in the final document.
- Every interface must include at least one `technical_entrypoints` string.
- Write strict JSON only to the request packet's `output_path`. No Markdown
  or prose around the JSON.

Then tell the user whether the map upload succeeded and include the map URL.

Linking is automatic: if a command prints `Linked this project to Unitbob as X.`,
relay that line to the user verbatim. Never ask for or guess a repo_id.
