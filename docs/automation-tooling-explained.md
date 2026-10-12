# Automation Tooling, Explained (for the operator)

A plain-English guide to the tools we've been discussing for automating your cold-email
business. Written to teach — assume no prior knowledge. If you read this top to bottom, you'll
understand what each piece is, why it exists, and how *you* will use it going forward.

> **A note on the names.** You listed these as "the trigger", "the death", "the Claude master
> server state trigger", "the dev". Speech-to-text scrambled them. The real tools are:
> **trigger.dev**, **Claude** (Claude Code + the Claude API), **MCP servers**, and the concepts
> of **triggers** and **durable state**. This doc uses the correct names throughout.

---

## The one-paragraph mental model

Think of your cold-email operation as a **kitchen**.

- The **scripts** (the `.ts` files in `skills/*/scripts/`) are the **appliances** — a blender, an
  oven. Each does one deterministic job: pull a list, score emails, audit deliverability.
- **Claude** is the **chef** — it makes judgment calls the appliances can't: "is this reply
  interested or hostile?", "is this company a fit?", "should we kill this campaign?"
- **trigger.dev** is the **kitchen manager with a schedule on the wall** — it decides *when*
  things run, presses the buttons for you, retries anything that fails, and keeps notes on what
  already got done so nothing is cooked twice.

Right now *you* are the kitchen manager: you manually invoke skills when you remember to.
trigger.dev is how you hand that manager job to software.

---

## Part 1 — Triggers (the core idea behind "trigger.dev")

A **trigger** is simply *"the thing that causes a job to start."* That's the whole concept.
Everything in automation is: **trigger → job runs → result**.

There are three kinds of trigger, and you'll use all three:

| Trigger type | Means | Example in your business |
|---|---|---|
| **Scheduled** (cron) | "run at these times" | Every Monday 9am, run the deliverability audit |
| **Event** | "run when X happens" | When bounce rate crosses 2%, run incident response |
| **Manual / on-demand** | "run because I (or another job) asked" | You click "launch campaign for domain X" |

**Cron** is the mini-language for scheduled triggers. It's five fields:
`minute hour day-of-month month day-of-week`. A few you'll recognize from our schedule:

```
0 9 * * 1     → 09:00, every Monday          (the Monday audit)
0 10 * * 3    → 10:00, every Wednesday        (the positive-reply sweep)
0 10 1 * *    → 10:00 on the 1st of the month (the monthly spam test)
```

You don't memorize cron — you use a site like crontab.guru to build the string, and trigger.dev
also lets you attach a **timezone** so "9am Monday" means *your* 9am, not UTC.

> Some cadences ("every *other* Monday", "first Monday of the *quarter*") can't be written in
> plain cron. The trick: schedule it every Monday, then add a one-line check at the top of the
> job that exits early on the weeks it shouldn't run. You'll see this pattern a lot.

---

## Part 2 — trigger.dev (the platform)

**What it is:** an open-source platform for running **background jobs** written in TypeScript.
"Background" = runs on its own, without you sitting there, without a browser open. You write the
job once; trigger.dev runs it on schedule, forever, and shows you a dashboard of every run.

It exists because the naive alternatives are bad:
- A plain cron job on your laptop dies when your laptop sleeps.
- A cron job on a server has no memory, no retries, no visibility — when it silently fails at
  3am, you find out days later (exactly the failure the weekly-rhythm skill warns about).

trigger.dev fixes those. Here are the concepts you actually need, in the order they matter:

### 2a. A "task"
A **task** is one unit of work — one job. In code it looks like a function with a name:

```ts
// trigger/monday-audit.ts   (illustrative — not yet in this repo)
import { schedules } from "@trigger.dev/sdk/v3";

export const mondayAudit = schedules.task({
  id: "monday-deliverability-audit",
  cron: { pattern: "0 9 * * 1", timezone: "America/New_York" },
  run: async () => {
    // 1. run the existing script
    // 2. read the result
    // 3. if a flag fired, notify you (or ask Claude to triage)
  },
});
```

The important idea: **the task wraps a script you already have.** You're not rewriting your
audit logic — you're giving it a scheduled button. Your `.ts` scripts stay the appliances; the
task is the manager pressing the button.

### 2b. Durable state (this is "the state" you mentioned)
**State = the job's memory of how far it got.**

Ordinary scripts are amnesiac: if a 40-minute list-build dies at minute 39, a plain script
starts over from zero. trigger.dev tasks are **durable** — they checkpoint their progress, so if
the machine restarts or a step fails, the job resumes from where it stopped instead of
restarting.

Your `list-builder` skill *hand-builds* this today (its "re-run the same command to resume"
behavior, driven by files on disk). trigger.dev gives you that resumability for free, as a
platform feature. That's why it's the natural home for long jobs.

### 2c. Retries
When a step fails (an API hiccups, a rate limit hits), trigger.dev automatically **retries** it
with increasing waits between attempts, instead of giving up. You set the policy ("try 3 times,
backing off"). This is huge for your world, where Prospeo/Smartlead APIs occasionally throttle.

### 2d. Concurrency & queues
**Concurrency = how many things run at once.** A **queue** lets you cap it. Example: Prospeo has
a rate limit (your repo already enforces a ~2.2 req/s floor). In trigger.dev you'd put all
Prospeo work on a queue with a concurrency limit, and the platform guarantees you never exceed
it — even across many campaigns firing at the same time. It replaces the hand-rolled limiter.

### 2e. Waits / delays
A task can **pause for a long time and resume later** — seconds, or *weeks* — without holding a
machine open. This is how you automate the two "wait" steps in your flow:
- "wait 21 days after launch, then run positive-reply-scoring"
- "wait ~2 weeks for inbox warmup, then allow sending"

You literally write `await wait.for({ days: 21 })` and the platform handles it.

### 2f. The dashboard
A web UI showing every run: which succeeded, which failed, logs, how long each took. This is
your **observability** — the answer to "did Monday's audit actually run?" is a glance, not a
guess. This is the single biggest upgrade over a laptop cron job.

### 2g. Cloud vs self-hosted
trigger.dev is open-source, so you can either:
- **Cloud** (trigger.dev's hosted service) — easiest, you just sign up. Recommended to start.
- **Self-hosted** — you run it on your own server. More control, more maintenance. Later, maybe.

### 2h. The CLI and how code gets there ("the dev")
You interact with trigger.dev through its command-line tool. The three commands you'll ever use:

```bash
npx trigger.dev@latest init      # one-time: connect this repo to your trigger.dev project
npx trigger.dev@latest dev       # local testing: runs your tasks on your machine to try them
npx trigger.dev@latest deploy    # ship tasks to the cloud so they run on schedule for real
```

`dev` (the local-testing command) is probably the "the dev" you said. The workflow is: write a
task → `dev` to test it → `deploy` to make it live.

### 2i. The one key you'll need
trigger.dev gives you a **`TRIGGER_SECRET_KEY`** (from its dashboard) that authorizes your repo
to talk to your trigger.dev project. It goes in your `.env`, right next to your other keys. It
does **not** replace any existing key — it sits *around* them, since your tasks still call
Smartlead/Prospeo/etc. using the keys you already have.

---

## Part 3 — Claude (the reasoning layer)

There are **two different ways** Claude shows up, and mixing them up causes confusion:

### 3a. Claude Code — the interactive assistant (this, right now)
Claude Code is the CLI you're typing into. It's **interactive**: you invoke `/skills`, it reads
files, runs scripts, talks back. Perfect for building, deciding, and one-off work. But it needs
*you* in the chair. It is **not** what runs at 9am on a Monday while you sleep.

### 3b. The Claude API — Claude called *by code*
The **Claude API** (a.k.a. the Anthropic API) is how a **program** asks Claude a question and
gets an answer back — no human, no chat window. This is the piece that lets an automated
trigger.dev task make a judgment call.

Concretely, inside a Wednesday-sweep task:

```
task runs → pulls the week's replies via Smartlead script
          → sends them to the Claude API: "classify each: interested / soft / referral / hostile"
          → Claude returns the labels
          → task acts on them (notify you about the hot ones)
```

The appliance (script) fetches; the chef (Claude API) judges; the manager (trigger.dev)
orchestrates. To use it you'd add an **`ANTHROPIC_API_KEY`** to `.env`. Use the latest model —
**Claude Opus 4.8** (`claude-opus-4-8`) for hard judgment, or a cheaper/faster model like
**Claude Haiku 4.5** for high-volume classification like reply-labeling.

> Rule of thumb: **Claude Code** is for *you* working *with* Claude. The **Claude API** is for
> *your software* working *through* Claude. Automation uses the API.

---

## Part 4 — MCP servers (the "server" you mentioned)

**MCP** (Model Context Protocol) is a standard way to give Claude **tools and data access**. An
**MCP server** is a small connector that exposes one system to Claude — "here's Google Drive",
"here's your Chrome browser", "here's your database" — so Claude can use it during a task.

You already have some connected (you saw "Google Drive" and "claude-in-chrome" available in this
session — those are MCP servers). You don't build these to start; just know the vocabulary:
- **MCP server** = the plug that connects Claude to one external tool.
- You'd reach for one when you want Claude to *do* something in another app (read a Sheet, drive
  a browser, query Postgres) rather than just think.

For your cold-email automation, MCP matters mostly later — e.g. giving an automated task the
ability to read/write your Google Sheet of leads, or drive Clay in a browser for the Track 6
playbooks. Not a day-one concern.

---

## Part 5 — The pieces you already have (scripts + keys)

So the new tools slot on top of things already in this repo:

- **The `.ts` scripts** (`skills/*/scripts/`) — plain TypeScript, run with `npx tsx <file>`. No
  build step, no dependencies. These are your appliances; trigger.dev tasks will call them.
- **`.env`** — your keychain. Every service key lives here (Smartlead, Prospeo, etc.). Automation
  adds two more lines to it: `TRIGGER_SECRET_KEY` and `ANTHROPIC_API_KEY`.
- **`tsx`** — the tool that runs TypeScript directly. Already how everything here runs.

---

## Part 6 — How you'll actually use this, going forward

Here's the day-to-day picture once it's wired up:

1. **You set it up once.** Sign up for trigger.dev, get the secret key, we write the six
   weekly-rhythm tasks, `deploy` them. Done — they now run forever.
2. **Most days you do nothing.** The Monday audit runs itself; if everything's clean, you get a
   "all clear" and move on.
3. **You get pinged only when a human is needed.** A campaign drops below the 1% rule → you get a
   message with the data and the recommended action. You decide.
4. **You watch the dashboard weekly** to confirm jobs are running (30 seconds).
5. **You keep using Claude Code interactively** for the creative/strategic work — writing copy,
   defining new ICPs, planning experiments. Automation handles the *rhythm*; you handle the
   *thinking*.

The goal is the exact thing the weekly-rhythm skill says separates hobbyists from top-1%
operators: **the cadence happens every single week whether or not you remember it** — but
without the silent-failure risk, because the dashboard and the notifications keep it honest.

---

## Glossary (one-liners)

- **Trigger** — the event that starts a job (a schedule, an occurrence, or a manual call).
- **Cron** — the five-field syntax for time-based triggers (`min hour day month weekday`).
- **trigger.dev** — open-source platform that runs your TypeScript background jobs, on schedule,
  with retries, memory, and a dashboard.
- **Task** — one job in trigger.dev; usually a thin wrapper around a script you already have.
- **Durable state** — a job's saved progress, so it resumes instead of restarting after a
  failure.
- **Retry** — automatic re-attempt of a failed step with growing delays.
- **Queue / concurrency** — controls on how many things run at once (e.g. to honor API rate
  limits).
- **Wait / delay** — a task pausing for seconds-to-weeks and resuming later (the 21-day wait).
- **Dashboard** — the web UI showing every run's status and logs (your observability).
- **Deploy** — pushing your tasks to trigger.dev's cloud so they run for real.
- **Claude Code** — the interactive assistant you chat with (needs you present).
- **Claude API / Anthropic API** — Claude called by *code*, no human, for automated judgment.
- **Model** — which Claude to use; e.g. `claude-opus-4-8` (smartest) or `claude-haiku-4-5`
  (fast/cheap for bulk classification).
- **MCP server** — a connector that gives Claude access to an external tool/data source (Google
  Drive, a browser, a database).
- **`.env`** — the file holding all your API keys; never committed to git.
- **tsx** — the tool that runs the repo's TypeScript scripts directly.
- **`TRIGGER_SECRET_KEY`** — the key that lets this repo talk to your trigger.dev project.
- **`ANTHROPIC_API_KEY`** — the key that lets your automated tasks call the Claude API.

---

*Next step when you're ready: sign up at trigger.dev, grab the secret key, and I'll scaffold the
six `cold-email-weekly-rhythm` tasks around the scripts you already have.*
