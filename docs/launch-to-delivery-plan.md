# Launch → Delivery: The Full Run Plan

This is the operating plan for taking one campaign from **nothing** to **live and delivering**,
using the skills in this repo. It says, at every stage: what I run, **what I check** (including
which API responses I inspect), the **gate** that must pass before moving on, and the **artifact**
produced. Nothing advances past a red gate.

Read this as the master checklist. Each stage links to the skill that does the real work.

```
PREFLIGHT → STRATEGY → INFRASTRUCTURE → LIST BUILD → CONTACTS+EMAILS
   → QUALITY GATE → COPY → UPLOAD (DRAFT) → REVIEW → GO LIVE → MEASURE → ITERATE
```

Legend: 🟢 = gate must pass to continue · 📄 = artifact written · 🔑 = API/key checked

---

## Stage 0 — Preflight (credentials + environment)

**Goal:** confirm the machine can actually talk to every service before we spend money or time.

**Run:**
```bash
npx tsx skills/cold-email-starter-kit/scripts/verify-credentials.ts
```

**What I check 🔑:**
- Each key in `.env` is present AND the service answers an authenticated test call (not just
  "the key is non-empty" — an actual round-trip):
  - `SMARTLEAD_API_KEY` → can list email accounts
  - `PROSPEO_API_KEY` → search endpoint authorizes
  - `MILLIONVERIFIER_API_KEY` → credit/balance endpoint answers
  - `DYNADOT_API_KEY` / `ZAPMAIL_API_KEY` → only if we're provisioning infra this run
  - `OPENAI_API_KEY` → only if we'll AI-qualify a list
- MillionVerifier **credit balance** is enough for the planned list size (~1 credit/email).

**🟢 Gate:** every key the plan will use returns a healthy response. A missing *optional* key is
fine (I note it and skip that lane); a missing *required* key stops the run.

📄 Nothing written — this is a health check.

---

## Stage 1 — Strategy (who, what offer, which angles)

**Goal:** lock the ICP, the free offer, and the campaign angles before touching lists or copy.

**Run (orchestrated by `/cold-email-kickoff`, or individually):**
1. `/icp-onboarding` — scrapes the website, interviews you → `client-profile.yaml`
2. `/lead-magnet-brainstorm` — picks the free offer/CTA
3. `/campaign-strategy` — 15-25 angles with value props
4. Synthesize → `campaign-plan.md`

**What I check:**
- `client-profile.yaml` has the fields the downstream scripts need: titles, seniorities,
  industries, headcount band, geography, hard filters, **excluded industries**.
- Industry names are **valid Prospeo industry names** (checked against
  `skills/icp-onboarding/references/prospeo-industries.md` — the 256-name list). This is the #1
  cause of a later `INVALID_FILTERS` error, so I validate it *here*, not at pull time.

**🟢 Gate:** profile is complete and every industry name is on the approved list.

📄 `profiles/<slug>/client-profile.yaml`, `lead-magnets.md`, `campaign-strategy.md`,
`campaign-plan.md`.

---

## Stage 2 — Infrastructure readiness (can we even send?)

**Goal:** confirm we have warmed inboxes to send from. **This is checked early on purpose** — the
worst failure is building a perfect list and having nowhere to send it.

**If infra doesn't exist yet:**
- `/zapmail-domain-setup-public` — buy domains (Dynadot) + provision inboxes (Zapmail).
  ⚠️ spends real money — I confirm with you first.
- `/smartlead-inbox-manager` — configure warmup + signatures + tag inboxes `active`.
- **Then wait ~2 weeks for warmup.** Sending from cold inboxes torches the domain.

**If infra exists — what I check 🔑 (via Smartlead API):**
- ≥20 inboxes tagged `active`.
- Each inbox's warmup status is healthy — **`is_warmup_blocked: false`**, reputation not "bad".
- Inboxes have been warming ≥2 weeks.

**🟢 Gate:** ≥20 healthy, warmed, `active`-tagged inboxes exist. If not, we stop here and fix
infra — no point building a list yet.

📄 `health-<date>.csv` from `list-health.ts` (the inbox snapshot).

---

## Stage 3 — List building (find the right companies)

**Goal:** a qualified list of target companies/people matching the ICP.

**Pick the lane** based on the ICP (each lane invokes `/icp-prompt-builder` as a required step):
- `/prospeo-full-export` — title-first (VP/Director/Head in specific industries)
- `/disco-like` — "more companies like these seed domains"
- `/google-maps-list-builder` — local SMBs
- `/blitz-list-builder` — named-account / domain-first
- `/competitor-engagers` — people engaging with competitor LinkedIn posts
- `/list-builder` — the meta-lane that sweeps every source, AI-qualifies, and snowballs until
  the market is dry (use for maximum coverage)

**What I run (list-builder lane — the thorough path):**
```bash
npx tsx scripts/make-judge.ts --spec=judge-spec.json --out=prompt.txt   # AI qualifier
npx tsx scripts/run-lane.ts   --config=lane.json                        # build
npx tsx scripts/snowball.ts   --config=lane.json                        # exhaustive sweep
```

**What I check:**
- **`/icp-prompt-builder` ran on a 50-lead sample first** and you approved the qualification
  logic — I never qualify a whole list against an unproven prompt.
- Prospeo filters validated at **PRECHECK** (emp band + every industry name) *before* any pull —
  a bad filter blocks the pull instead of wasting credits.
- After each stage, I read **`summary.md`** — its first line is `# READY` or `# NOT READY` with
  the next command embedded.
- `reject-audit.csv` — if the judge disagreed with itself >15%, the auto-rescue already ran; I
  spot-check it didn't over-reject good companies.
- **API pacing:** Prospeo stays under its rate floor (the shared limiter handles this; I never
  lower `PROSPEO_MIN_INTERVAL_MS`). Rate-limit penalties are waited out, not fought.

**🟢 Gate:** `summary.md` reads **`# READY`**. That is the *only* green light. A lane with any
failed stage is not deliverable — I re-run the same command (that's the whole recovery model)
until it's READY or a permanent 400-class error names the field to fix in `lane.json`.

📄 `~/output/list-builder/lanes/<client>-<lane>/` (companies, summary, audits).

---

## Stage 4 — Contacts + emails (people, then *send-ready* emails)

**Goal:** turn the approved company list into people with **validated** email addresses.

**Run (only after you approve the company list):**
```bash
npx tsx scripts/contacts.ts --config=lane.json
```

**What I check 🔑 — the email waterfall + validation (the part people get wrong):**
- Contacts pulled through the waterfall: **GetLeads → Blitz → Prospeo** (uncapped, all titles).
- **Every** contact goes through the email finder. Provider emails (GetLeads/Blitz/Prospeo) are
  **never send-ready on their own** — `leads-final.csv` is built from the *Final Email* column
  only.
- **MillionVerifier runs on every candidate email.** I keep only `ok`/valid results.
  - Expected loss: **~20-30% of found emails are rejected** by MV — that's normal, not a bug.
  - Expected *find* rates vary by segment: retail/SMB ~99%, B2B tech ~65-80%, healthcare/public
    ~25-40%. A very low find rate means the ICP targets hard-to-reach people (widen or accept
    the cost) — not a failure to retry blindly.

**🟢 Gate:** `leads-final.csv` contains only MillionVerifier-passed emails, with the required
columns for upload: `email, first_name, last_name, company_name` (+ optional `company_domain,
title, linkedin_url`).

📄 `leads-final.csv`.

---

## Stage 5 — Quality gate (grade before you spend send reputation)

**Goal:** catch a bad list *before* it touches your inboxes.

**Run:**
```bash
/list-quality-scorecard
```

**What I check:**
- Grade across **8 dimensions** (dedupe, email validity, ICP fit, completeness, etc.), scored
  A+ to F, with the top issues called out.
- Duplicates removed (Smartlead also dedupes per-campaign server-side, but I dedupe first).

**🟢 Gate:** grade is acceptable (aim B+ or better). A low grade sends me back to Stage 3/4 to
fix targeting or re-validate — not forward to upload.

📄 `scorecard-<date>.md`.

---

## Stage 6 — Copy (write it, then QA it)

**Goal:** A/B/C copy that's specific, personalized, and won't trip spam filters.

**Run:**
1. `/campaign-copywriting` — stepwise: direction → subject → body → final → `variants.yaml`
   (+ per-lead `situation_line` / `value_line` / `cta_line` if personalizing).
2. `/spam-word-checker` — scan the copy.

**What I check:**
- `variants.yaml` matches the schema the uploader expects (`name`, `schedule`,
  `inbox_selection`, `sequences` with ≥1 step) — a mismatch fails the upload fast, so I verify
  it now.
- Spam scan is clean: no banned phrases ("leverage", "synergy", "solutions", "world-class",
  "cutting-edge"), no em dashes, body 50-90 words, subject <60 chars, ends with `%signature%`.

**🟢 Gate:** spam-word-checker passes and `variants.yaml` validates.

📄 `profiles/<slug>/campaigns/<campaign-slug>/variants.yaml`.

---

## Stage 7 — Upload to Smartlead (DRAFT only)

**Goal:** assemble the campaign in Smartlead — **as a DRAFT**. A launch never fires from a script.

**Run:**
```bash
npx tsx skills/smartlead-campaign-upload-public/scripts/upload.ts \
  --leads=profiles/<slug>/campaigns/<campaign-slug>/leads-final.csv \
  --variants=profiles/<slug>/campaigns/<campaign-slug>/variants.yaml
```

**What the script does + what I check 🔑 (Smartlead API):**
1. Validate `leads.csv` columns + count rows.
2. `POST /campaigns/create` → campaignId.
3. `POST /campaigns/{id}/sequences` with all A/B/C variants.
4. `GET /email-accounts?limit=100` → filter by tag `active`, sort by `daily_sent_count` ASC
   (**LRU** — least-recently-used inboxes first), attach top N.
   - I check: enough tagged inboxes exist; if `inbox_selection.count` exceeds them, the script
     attaches all available **and warns** (I surface that warning to you).
5. Batch-upload leads (100/batch) with custom fields mapped.
6. `POST /campaigns/{id}/settings` — tracking **off**, **stop-on-reply on**.
7. `POST /campaigns/{id}/schedule` — Mon-Fri, business hours, throttle (e.g. 30/day/inbox).
8. Print the campaign URL. **Does NOT activate.**

**🟢 Gate:** script prints `Campaign is in DRAFT` + a review URL, with lead count and inbox count
matching expectations.

📄 A DRAFT campaign in Smartlead (id + URL).

---

## Stage 8 — Human review + GO LIVE (your click, not mine)

**Goal:** you eyeball the assembled campaign and press Start. This is deliberately manual.

**What you review in the Smartlead UI:**
- Subject lines + body previews render correctly (variables filled, no `{{broken}}` tokens).
- Inbox assignment: right tag, right count.
- Lead count + a few random lead rows look real.
- Schedule: timezone, hours, throttle.

**🟢 Gate:** **you** hit **Start** in the Smartlead UI. Nothing I run activates a campaign.

📄 Live campaign; log it to `profiles/<slug>/experiments/<date>-<campaign>.json`.

---

## Stage 9 — Delivery watch (first 7 days)

**Goal:** confirm the campaign is actually *delivering*, not silently failing.

**Run (per `/cold-email-weekly-rhythm`, Mondays):**
```bash
/email-deliverability-audit --days=7
```

**What I check 🔑:**
- Campaign is sending (not stuck at 0 — if it is: check schedule, inbox warmup,
  `is_warmup_blocked`, and that leads uploaded).
- Fleet reply rate over 7 days ≥ **1%** (the 1% rule).
- Bounce rate < **2%** (spike ⇒ dead emails ⇒ re-validate; pause the offender first).
- No inbox flagged `flag_high_bounce`; no campaign flagged `flag_low_reply`.

**🟢 Gate:** delivering, bounces in range, 1% rule holding. Any red → `/deliverability-incident-response`.

---

## Stage 10 — Measure (day 21) & iterate

**Goal:** score the outcome and decide the next move. 21 days is the minimum for reply-rate to
stabilize.

**Run:**
```bash
/positive-reply-scoring --campaign-id=<id>
```

**What I check:**
- **Positive reply rate** = positive replies / total sent (the north-star metric, not raw
  replies).
- Reply classes: `positive_interested` / `positive_soft` / `positive_referral` /
  `negative_hostile`. Hostile spike ⇒ targeting or copy problem.

**Decision:**
- **Winner** (≥2× baseline) → scale (clone to more inboxes).
- **Middling** → `/experiment-design` to change **one** variable and rerun.
- **Loser** (<50% baseline) → kill, document why in the experiment log.

📄 `profiles/<slug>/scores/<campaign-id>-<date>.json` + experiment-log update.

---

## The fully-automated variant (once you've done it manually once)

`/auto-research-public --domain=<target.com>` compresses Stages 3-7 into one ~20-minute run for a
single target: scrape → Claude writes ICP filters → Prospeo pull → email waterfall + MillionVerifier
→ Claude writes A/B/C copy → parallel sub-agent personalization → Smartlead upload. It pauses
before copy (Phase 5) and upload (Phase 7) for your review. Prerequisites are the same gates as
above: `client-profile.yaml`, the three API keys, and ≥20 warmed `active` inboxes.

> This is also the piece we'd later hand to **trigger.dev** for scheduled daily launches — see
> `docs/automation-tooling-explained.md`.

---

## The non-negotiables (what I will not do)

- **Never send from cold inboxes.** ≥2-week warmup is a hard gate.
- **Never send provider (GetLeads/Blitz/Prospeo) emails un-validated.** Every email clears
  MillionVerifier first.
- **Never activate a campaign from a script.** Upload is DRAFT; *you* press Start.
- **Never advance past a red gate** — a `# NOT READY` lane, a failing scorecard, a spam-flagged
  copy, or a blocked inbox stops the line until it's fixed.
- **Never trim a list sweep or cap contacts to save cost.** Recall is the product.
- **Never lower Prospeo pacing** or call it outside the shared limiter.
```
