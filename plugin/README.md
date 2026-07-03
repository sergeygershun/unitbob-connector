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
- **Python 3.10 or newer** installed — building the map uses a small local tool
  called `graphify` that Claude installs for you the first time; it needs Python.
- Two values from whoever runs Unitbob for you: the **server address** and your
  **repo id** (a number).

## Step 1 — Add the Unitbob marketplace (once)

A "marketplace" is just the place a plugin comes from — like adding an app store.
Adding it installs nothing yet; it only tells Claude where to find the Unitbob
plugin. You can do it two ways — pick whichever you like.

**Option A — by hand (in the app)**

1. Open **Settings** → in the left menu under **Customize**, click **Plugins**.
2. Top-right, click **Add ▾** → **Add marketplace**.
3. Enter `sergeygershun/unitbob-connector` and confirm.

**Option B — just ask in chat**

Open a Claude Code session (the **Code** tab) in any project and say:

> Add the Unitbob plugin marketplace: `sergeygershun/unitbob-connector`

Claude adds it for you and confirms.

## Step 2 — Install the plugin (once)

Now install the plugin from that marketplace. Again, two ways:

**Option A — by hand (in the app)**

In **Settings → Customize → Plugins**, click **Browse**, find **unitbob**, and
click **Install**.

**Option B — just ask in chat**

> Install the unitbob plugin

After installing, start a new session so the new commands load.

## Step 3 — Link your project (once, Claude does it for you)

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

## Step 4 — Everyday use

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
