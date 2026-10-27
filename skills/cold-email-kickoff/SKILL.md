---
name: cold-email-kickoff
description: Single "start here" orchestrator for new cold email operators. Asks infrastructure-status questions first, then runs /icp-onboarding → /lead-magnet-brainstorm → /campaign-strategy in sequence, producing a consolidated campaign-plan.md. Ends with an interactive menu of next skills branched on whether the user already has domains/inboxes. Use as the very first invocation on any new repo checkout or when onboarding someone to cold email from zero.
---

# Cold Email Kickoff

The single entry point for a fresh user. Replaces "stare at 29 skills and guess which to run first."

## When to use

- First-time cold email operator on this repo
- New client/business being onboarded (fresh `profiles/<slug>/` directory)
- Experienced operator starting a new campaign for a new business
- Anyone who asks "where do I start?"

## What this skill produces

- A populated `profiles/<business-slug>/client-profile.yaml` (from `/icp-onboarding`)
- A `profiles/<business-slug>/lead-magnets.md` with the chosen free offer
- A `profiles/<business-slug>/campaign-strategy.md` with 15-25 campaign ideas
- A consolidated `profiles/<business-slug>/campaign-plan.md` — a single-page summary you can show stakeholders
- An interactive menu pointing at the right next skill based on your infrastructure status

## Flow

### Step 1 (asked FIRST): Infrastructure status

Before touching any business context, ask:

1. **"Which sequencer do you use — Instantly or Smartlead?"** and **"Do you already have sending domains + inboxes set up there?"** (yes / no / not sure). Default to Instantly if they have no preference; they stay in that tool for the rest of the flow.
2. **"At least 20 inboxes that have been warming for 2+ weeks?"** (yes / no)
3. **"Do you have API keys for your sequencer (Instantly or Smartlead) + Prospeo + MillionVerifier in your `.env`?"** (yes / partial / no). Instantly users can skip the sequencer key: `/instantly-campaign-prep` works from files.

These answers determine the next-step menu at Step 6. Save them as `infrastructure_status` in the profile.

### Step 2: Load or create the business profile

Check for `profiles/<business-slug>/client-profile.yaml`:

- **Exists** → load it. Ask: "Use this existing profile (answer: `use`) or start fresh (answer: `new`)?"
- **Doesn't exist** → invoke `/icp-onboarding`. This scrapes the user's website first, then interviews them. Produces the profile.

### Step 3: Ensure lead magnet is chosen

Check the loaded/created profile for a `lead_magnet` field:

- **Empty** → invoke `/lead-magnet-brainstorm`. It asks 4 intake questions, scores 10 magnet archetypes, picks a top 2-3, updates the profile.
- **Already set** → confirm with the user: "Using `<chosen magnet>` as your free offer. OK?" — if they want to change it, re-invoke `/lead-magnet-brainstorm`.

### Step 4: Generate campaign strategy

Invoke `/campaign-strategy`. It takes the profile + website + any case studies it can scrape and produces 15-25 campaign ideas ranging from broad to niche, with AI personalization + value-prop + campaign-overview per idea.

Saved to `profiles/<slug>/campaign-strategy.md`.

### Step 5: Synthesize campaign-plan.md

Pull from all three artifacts above. Write `profiles/<slug>/campaign-plan.md`:

```markdown
# Campaign Plan — <business name>
Generated: YYYY-MM-DD

## Business
<one-liner from profile>
Website: <url>

## ICP
- Titles: <titles>
- Industries: <industries>
- Headcount: X-Y
- Geography: <countries/states>
- Hard filters: <list>
- Excluded industries: <list>

## Offer & Lead Magnet
- Primary CTA: <cta>
- Free hook: <lead magnet name>
- Delivery: <how you deliver it>

## Top 3 Recommended Campaigns (from /campaign-strategy)
1. **<name>** — <one-line why + value prop>
2. **<name>** — <one-line why + value prop>
3. **<name>** — <one-line why + value prop>

Full strategy in: profiles/<slug>/campaign-strategy.md

## Infrastructure Readiness
Based on your Step 1 answers:
- [ ] SMARTLEAD_API_KEY in .env: <yes/no>
- [ ] PROSPEO_API_KEY in .env: <yes/no>
- [ ] MILLIONVERIFIER_API_KEY in .env: <yes/no>
- [ ] Domains purchased: <yes/no>
- [ ] Inboxes warmed 2+ weeks: <yes/no>

## Next Steps
<branched — see Step 6 below>
```

### Step 6: Interactive next-skill menu

Branch on Step 1 answers.

**If NO infrastructure (or "not sure"):**

```
Your next step is provisioning domains + inboxes. This takes ~2 weeks (because inboxes need
to warm). Menu:

[A] Start the domain + inbox setup NOW  → /zapmail-domain-setup-public then /smartlead-inbox-manager
[B] Save the plan and come back after I have infra
[C] I want to build my list FIRST (warning: risky — without warmed inboxes, you can't send safely)

Pick A / B / C:
```

If A: orient the user, then invoke `/zapmail-domain-setup-public`. After that skill completes, invoke `/smartlead-inbox-manager` for config. Remind the user to wait 2 weeks for warmup before launching. For Instantly users, inbox warmup, signatures and tags are set in the Instantly UI (there is no Instantly inbox-manager skill yet); use `/smartlead-inbox-manager` only for Smartlead.

**If INFRASTRUCTURE READY (warmed inboxes + API keys present):**

Look at the ICP type in the profile and recommend a list-building skill:

```
Your infra is ready. Time to build your list. Based on your ICP (<summary>), the best fit is:

[A] /prospeo-full-export       → title-first search (best for: VP/Director/Head roles in specific industries)
[B] /disco-like                → lookalike discovery (best for: "more companies like <seed domains>")
[C] /google-maps-list-builder  → local SMBs (best for: restaurants, clinics, contractors, etc.)
[D] /blitz-list-builder        → domain-first (best for: named-account ABM, specific company list)
[E] /competitor-engagers       → LinkedIn engagement (best for: people actively engaged with competitors)

Recommendation: <one of A-E based on ICP>. Pick A / B / C / D / E:
```

Invoke the picked skill. After it completes, remind user: `/icp-prompt-builder` runs inside that skill (required step), then `/list-quality-scorecard`, then `/campaign-copywriting`, then `/instantly-campaign-prep` (Instantly) or `/smartlead-campaign-upload-public` (Smartlead).

### Step 7: Offer to open the plan

Print the `campaign-plan.md` path. Offer `open <path>` if macOS.

## Safeguards

- **Don't re-run `/icp-onboarding` blindly.** If a profile exists, ASK before overwriting.
- **Don't auto-invoke `/zapmail-domain-setup-public`.** It spends real money. Always confirm first.
- **Don't skip the 2-week warmup warning.** Make it loud if the user picks option [C] of the no-infra menu.

## Why this skill exists

Without kickoff, a new user opens the repo, sees 29 skills, and has no idea which to run first. Every single new operator asks the same question ("where do I start?") and the answer is identical. This skill is that answer, codified.

Also: putting the infrastructure question FIRST prevents the most common failure mode — someone writes beautiful copy, builds a great list, then realizes they can't send because they have no warmed inboxes.

## What to do next

Follow whichever branch your Step 6 menu selected. The skill hands you off cleanly to the right next step.

**Or wait:** if you picked [B] from the no-infra menu (save plan, come back later), return to this skill after your domains have warmed for 2 weeks. Load the existing profile and skip to Step 6.

## Related skills

- `/icp-onboarding` — invoked in step 2 (scrapes website + interviews)
- `/lead-magnet-brainstorm` — invoked in step 3 (picks free offer)
- `/campaign-strategy` — invoked in step 4 (15-25 campaign ideas)
- `/zapmail-domain-setup-public` — offered in step 6 if no infra
- `/smartlead-inbox-manager` — offered in step 6 after domain setup
- `/prospeo-full-export`, `/disco-like`, `/google-maps-list-builder`, `/blitz-list-builder`, `/competitor-engagers` — offered in step 6 if infra ready

## References

- `references/example-campaign-plans/b2b-saas.md` — sample campaign plan for a B2B SaaS client
- `references/example-campaign-plans/smb-restaurant.md` — sample for a local restaurant chain
- `references/example-campaign-plans/agency.md` — sample for a marketing agency
