Rebuild the map for this project. It has **two lenses of one graph state**, both
built locally and uploaded as one atomic bundle:

- **My product** (the surface map) — the app in the vibecoder's terms: routes,
  screens, jobs, tables, external services, grouped into capabilities.
- **Internal structure** (the decompose map) — the code's own subsystems.

Do this:
1. Run `npx -y --loglevel=error unitbob@0.1.10 map-prepare`. It refreshes the code
   graph and writes the build request.
2. Read `.unitbob/map-build/request.json`. It gives you `project_root`,
   `graph_path`, `output_path`, `surfaces_path`, `surface_output_path`, and the
   fetched recipes.
3. Read the graph at `graph_path`. **This is your input — both maps are built
   from it (plus, for the surface map, the project source).**
4. Build **both** lenses locally (see below).
5. Run `npx -y --loglevel=error unitbob@0.1.10 put-map-build`. It uploads the
   graph, `map_document.json`, `surfaces.json`, and `surface_document.json`
   together; if either lens is missing or invalid the whole upload is rejected
   and the previous map stays current.

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

## Building the maps (step 4)

- The code never leaves the machine (MVP aside): everything you read stays under
  `project_root`, and the only thing that goes anywhere is the finished maps.

### Internal structure (decompose map → `output_path`)

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
- Write strict JSON only to the request packet's `output_path`.

### My product (surface map → `surfaces_path`, then `surface_output_path`)

- First follow `recipes.extract_surfaces.text`: read the source and the graph and
  write the flat surface inventory to `surfaces_path`. Every `route`/`job` carries
  a `handler_symbol` that is a **graph node id copied character for character** —
  never a name you spell yourself.
- Then follow `recipes.decompose_surfaces.text`: group those surfaces into
  capabilities and write the surface document to `surface_output_path`. Copy every
  surface id **verbatim** into the capability lists — the host checks coverage by
  exact string match, so any rewrite reads as a lost surface.
- Write strict JSON only to each path. No Markdown or prose around the JSON.

Then tell the user whether the map upload succeeded and include the map URL.

Linking is automatic: if a command prints `Linked this project to Unitbob as X.`,
relay that line to the user verbatim. Never ask for or guess a repo_id.
