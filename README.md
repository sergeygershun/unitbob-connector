# Unitbob

A living map of your app's business parts. Each important seam gets an automatic
test — a "lamp" on the map. Green means fine, red means something broke.

You work through Claude Code. You need: Node 18+, Python 3.10+.

---

## Install (once)

**With a prompt:**
```
Add the Unitbob plugin marketplace: sergeygershun/unitbob-connector
Install the unitbob plugin
```

**With commands (in the terminal):**
```
claude plugin marketplace add sergeygershun/unitbob-connector
claude plugin install unitbob@unitbob
```

Restart the session so the commands load.

---

## Full cycle

| Step | With a prompt (just type in chat) | With a command |
|------|-----------------------------------|----------------|
| 1. Build the map | `Build my Unitbob map` | `/unitbob:map` |
| 2. Generate tests | `Generate the guardrail tests` | `/unitbob:suite` |
| 3. Run the checks | `Run the checks` | `/unitbob:check` |
| 4. Fix a red lamp | `Fix guardrail <id>` | `/unitbob:fix <id>` |
| 5. Open the map | `Open my Unitbob map` | `/unitbob:show` |

---

## How to read it

- **Green lamp** — the behavior works.
- **Red lamp** — something the structure relied on broke. Copy its `id` and run
  step 4.
- The project links itself by folder name — nothing to set up by hand.
