# Unitbob for Claude Code

Unitbob draws a living map of your app's business parts and puts a small guard
(an automatic test) on each important seam. On the map each guard is a lamp:
green means fine, red means something the app relied on just broke. You work with
it entirely by chatting with Claude Code — no terminal needed.

## What you need

- The **Claude Code app** (desktop or the IDE extension). You do not use a
  terminal.
- **Node.js 18 or newer** installed on your machine — the plugin uses it behind
  the scenes. (If a step later says "npx not found", install Node from
  [nodejs.org](https://nodejs.org) and try again.)
- Two values from whoever runs Unitbob for you: the **server address** and your
  **repo id** (a number).

## Step 1 — Install the plugin (once, point-and-click)

In Claude Code, type `/plugin` and press Enter. A panel opens.

1. Open the **Marketplaces** tab → **Add** → enter:
   `sergeygershun/unitbob-connector`
2. Open the **Discover** tab → pick **unitbob** → **Install**.

Then start a new chat (or restart Claude Code) so the new commands appear.

> If typing `/plugin` does nothing, update Claude Code to the latest version and
> try again — the plugin manager lives in recent versions.

## Step 2 — Link your project (once, Claude does it for you)

Open your project in Claude Code and just ask, in plain words:

> build my unitbob map

The first time, Claude Code notices the project isn't linked yet and asks you for
two things:

- the **server address** (for example `http://localhost:3000`, or the URL you
  were given)
- your **repo id** (the number you were given)

Give it those two values. Claude Code sets everything up itself and keeps going.

> **Don't type `/init`.** That is a different, built-in Claude Code command and
> has nothing to do with Unitbob. To set up Unitbob, just answer Claude's
> questions or say "set up unitbob".

## Step 3 — Everyday use

Just talk to Claude Code. Each request also has a matching command if you prefer:

| What you want | Say this | Command |
| :--- | :--- | :--- |
| Build or refresh the map | "build the map" | `/unitbob:map` |
| Create the guardrail checks | "generate the checks" | `/unitbob:suite` |
| Run the checks | "run the checks" | `/unitbob:check` |
| Open the map | "open the map" | `/unitbob:show` |
| Fix a red guard | "fix guard <id>" | `/unitbob:fix <id>` |

When the map shows a **red lamp**, copy the guard id shown on it and ask Claude to
fix that guard. Claude edits the code locally, then asks you to run the checks
again.

## What you never do

- Open a terminal.
- Type `npx`, `git`, or install commands.
- Create or edit config files by hand.

Claude Code does all of that for you — you only chat and approve.

## Your code stays private

Unitbob never uploads your source code. Claude Code reads your files locally and
sends only the generated map, the generated checks, and the check results to the
Unitbob server.
