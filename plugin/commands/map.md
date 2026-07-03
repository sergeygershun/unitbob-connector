---
description: Rebuild the Unitbob map of this project's business subsystems.
---

Rebuild the architecture map for this project.

Do this:
1. Run `npx unitbob@0.1.3 map-prepare`.
2. Read `.unitbob/map-build/request.json`.
3. Build the map locally:
   - Read source files directly from the request packet's `project_root` with
     local file tools.
   - Do not upload source anywhere.
   - Use the fresh graph at `graph_path`.
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
4. Run `npx unitbob@0.1.3 put-map-build`.

Then tell the user whether the map upload succeeded and include the map URL.

Linking is automatic: if a command prints `Linked this project to Unitbob as X.`,
relay that line to the user verbatim. Never ask for or guess a repo_id.
