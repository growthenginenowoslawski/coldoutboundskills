---
name: smartlead-reply-agent-generator
description: Generates Smartlead Reply Agent configuration (Reply Goal, Lead Category, Tone & Length, and the freeform guidance block) for a specific outbound or seeding campaign — paste campaign details + brand voice and get back copy-pasteable config. Use when setting up Smartlead's Reply Agent for a new campaign, especially UGC/creator seeding outreach where replies need consistent voice and hard guardrails on sensitive topics. Triggers on "reply agent", "Smartlead AI agent", "set up auto-reply", "creator seeding reply agent".
---

# Smartlead Reply Agent Generator

Adapted from a Gamma-hosted "Instantly AI Reply Agent Generator" playbook found 2026-08-23
(`https://copy-of-playbook-how-to--xx6sbgu.gamma.site/`). **Not a find-replace port** — Instantly
and Smartlead's reply-agent products are structurally different, verified against Smartlead's
own docs (helpcenter.smartlead.ai/en/articles/431) before adapting:

| | Instantly AI Agent | Smartlead Reply Agent |
|---|---|---|
| Config surface | 4 named fields (Communication Style, Context and Clarification, Handover and Escalation, Other Guidance) | Reply Goal (dropdown: Book Meeting / Re-engage / Qualify / Close), Lead Category, Tone & Length, one freeform guidance field |
| Send mode | Can send autonomously | **Draft-only today** — every reply requires manual review/send in Master Inbox. Auto-send is listed "coming soon," not live as of 2026-08-23. |
| Escalation | Agent "escalates silently" mid-conversation | Not needed the same way — nothing sends without a human clicking Accept, so escalation = **what NOT to draft an answer for**, not a live handoff |

Because Smartlead has no equivalent of Instantly's 4 discrete fields, this skill collapses them
into the **one guidance field Smartlead actually accepts**, organized with clear internal
headers so nothing from the original framework is lost — it just all lives in one box instead
of four. Re-verify this table against Smartlead's current docs before relying on it; reply-agent
features change fast and auto-send may have shipped since this was written.

## Inputs (same as the original playbook — don't invent any of these)

1. **Campaign details** — full brief, landing page copy, or any doc describing what the
   recipient gets, what they need to do, dates, deliverables, rewards. More context is better.
2. **Brand voice** — website copy, social captions, an About page, ad scripts. 3-4 sentences is
   enough. If none provided, ask for one line describing the brand and default to warm/direct.
3. **Sender name** — who the agent replies as (first name only, e.g. Julia, Chelsea).
4. **Reply Goal** — which of Smartlead's four goals fits this campaign: Book Meeting / Re-engage
   / Qualify / Close. For creator-seeding campaigns this is usually **Qualify** (surface interest,
   route to signup) rather than Book Meeting.
5. **Signup/booking link** — the one link the agent should offer to genuinely interested replies.
6. **Anything else worth flagging** (optional) — sensitive-topic handling, banned words, a
   separate affiliate/ambassador track, anything the agent can't infer from #1-2.

If any of #1-5 is missing or vague, ask for it — do not guess dates, rates, product names, or links.

## Output: the Smartlead config

Produce three short selections plus one consolidated guidance block.

**Reply Goal:** [one of the four Smartlead options, matched to the campaign]

**Lead Category:** [what this batch of leads is — e.g. "UGC creator seeding — inbound replies"]

**Tone & Length:** [one line — e.g. "Warm, direct, first-person. Default 150 words, up to 175 for
complex questions."]

**Guidance** (this is the one field Smartlead lets you write freely into — put everything here,
under these sub-headers so a human editing it later can still find each piece):

```
VOICE & STYLE
- [tone/voice rules pulled from the brand samples; preserve signature phrases; respect banned words]
- No em dashes. Use commas, periods, parentheses, or colons instead.
- Reply in first person as [Sender Name]. Never say "let me loop in the team" — if something is
  outside scope, don't draft an answer for it at all (see NEVER DRAFT AN ANSWER FOR, below);
  this is a draft-review workflow, so an unanswered question just waits for a human, it doesn't
  need a fake in-message handoff line.
- Sign off: "xx [Sender Name]"

COMMON REPLY PATTERNS
- "I'm interested" -> [what to say, incl. how to introduce the signup link]
- "What should I do / film / provide?" -> [pull from campaign details]
- "Tell me more" -> [pull from campaign details]
- "I'm hesitant about the commitment" -> [address the specific friction from the brief]
- [campaign-specific pattern] -> [...]
- Cap follow-up questions at one per reply.

NEVER DRAFT AN ANSWER FOR (leave for a human instead)
- Medical questions, rate/payment negotiation, contract or exclusivity questions,
  shipping/payment disputes, agency-rep inquiries, complaints, press inquiries
- [campaign-specific additions, e.g. disordered-eating disclosures on food/wellness campaigns,
  medication questions on health-adjacent campaigns]
- Because Smartlead requires manual send today, these simply get left as an unaccepted draft or
  skipped — flag that explicitly to whoever's reviewing the Master Inbox queue.

SIGNUP LINK HANDLING
- Only offer the link to replies that have expressed real interest, never as a cold-continuation.
- Template: "Here's your spot to sign up: [LINK]. Reply anytime if you want help before then."

REFERENCE FACTS
- [dates, deliverables, rewards, product name, tags/hashtags — pulled verbatim from the campaign
  details, not paraphrased into something that could drift from the brief]
```

## Sensitive-topic guardrail (carried over from the original, still correct)

If the campaign touches a sensitive or health-adjacent topic (weight loss, mental health,
menopause, chronic illness, body image, etc.), build hard guardrails into VOICE & STYLE and
NEVER DRAFT AN ANSWER FOR automatically — don't wait to be asked. If the brand has its own
written compliance rules (regulated supplement/health claims, FTC disclosure requirements,
etc.), reconcile against that file directly instead of re-deriving the rules here.

## Don't invent facts

If a detail is genuinely unclear from what was pasted, say so at the end and ask for
clarification instead of guessing dates, rates, or product names — same rule as the original
playbook, worth keeping.
