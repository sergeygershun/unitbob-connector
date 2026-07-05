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

That's all. You don't need a server address, an account, or any id — Claude
links your project for you (see Step 3).

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

**Then start a new session (new chat).** The `/unitbob:...` commands only load
when a session starts — in the session where you installed the plugin they don't
exist yet. If you ever type a command and see *"Unknown command: /unitbob:..."*,
that's all it is: start a new chat and it will work.

## Step 3 — Link your project (automatic — nothing to do)

Open your project in Claude Code and just ask, in plain words:

> build my unitbob map

The first time, Claude Code links the project by itself — it registers your
project on the Unitbob server by its folder name and remembers the link. You
don't type a server address or any id, and there's no form to fill in. Claude
just replies with one line like *"Linked this project to Unitbob as your-app."*
and carries on. (This first map may also install `graphify`; let Claude do it.)

> **Don't type `/init`.** That is a different, built-in Claude Code command and
> has nothing to do with Unitbob. To set up Unitbob, just say "build my unitbob
> map" — Claude handles the rest.

## Step 4 — Your first run (map → checks → fixes)

The first time, do these four in order — each one builds on the one before. Just
say the words in chat; Claude does the work.

1. **Build the map.** Say *"build my unitbob map"*. Claude reads your code
   locally and draws the map of your app's business parts on the server. Takes a
   couple of minutes.
2. **Create the checks.** Say *"generate the checks"*. Using that map, Claude
   writes one small guard (an automatic test) for each important seam and uploads
   them. A couple of minutes again.
3. **Run the checks.** Say *"run the checks"*. Claude runs the guards locally and
   lights each lamp on the map green or red.
4. **Fix a red lamp.** If a lamp is red, copy the guard id shown on it and say
   *"fix guard <id>"*. Claude edits the code locally to restore what broke, then
   asks you to run the checks again.

You only need this full sequence once. After that, see Step 5.

> **A few approval prompts are normal.** Building the map and the checks runs
> some small commands on your machine, so Claude asks your permission each time —
> just approve and let it continue. It can also ask to install `graphify` on the
> first map; say yes. Nothing leaves your machine except the finished map and the
> check results.

## Step 5 — Everyday use

Just talk to Claude Code. Each request also has a matching command if you prefer.
(Commands register when a chat starts — if one comes back as
*"Unknown command"*, start a new chat; plain words always work either way.)

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
