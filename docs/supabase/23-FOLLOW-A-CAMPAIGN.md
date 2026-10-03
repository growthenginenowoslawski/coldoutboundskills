# Follow a Campaign From Idea to Results

This document traces a single campaign — "Bootstrapped Agency Founder — ROCI Profitability Angle" — from the moment the idea is generated through 21 days of sending and into the results analysis. Every table touched, every key transition.

## The Campaign

- **Client:** Gramscode (ROCI product)
- **Campaign name:** Bootstrapped Agency Founder — ROCI Profitability Angle
- **Sequence:** 4 emails over 11 days (Day 0, 3, 7, 11)
- **Target:** UK digital agency founders, 10-75 headcount, bootstrapped
- **Offer:** Free Agency Profitability Audit (lead magnet)
- **List size:** 197 verified contacts

---

## Day -30: Campaign Idea Brainstormed

`/campaign-strategy` runs for Gramscode. 20 ideas generated.

**Writes to `campaign_strategies`:**
```
campaign_name:    "Bootstrapped Agency Founder — ROCI Profitability Angle"
targeting_level:  Focused
list_filters:     "10-75 headcount; UK only; bootstrapped; no PE"
value_proposition:"Most agencies leave 30-40% gross profit on the table"
is_no_ai:         false
rank:             null        ← not ranked yet
status:           draft
```

Then client reviews → top 3 ranked:
```
UPDATE campaign_strategies SET rank = 1, status = 'approved'
WHERE id = ... (this campaign)
```

---

## Day -28: Campaign Plan Synthesized

`/cold-email-kickoff` Step 5 synthesizes everything.

**Write to `campaign_plans`:**
```
top_campaign_names: ["Bootstrapped Agency Founder — ROCI Profitability Angle",
                     "New Ops Hire Signal",
                     "Lost Client Signal"]
infrastructure_status: {"warmup_days_remaining": 14}
status: draft
```

---

## Day -25 to -14: Infrastructure Warmup

No database writes. Domains warming in Smartlead's warmup pool.

---

## Day -14: List Building Starts

`list-builder` pulls UK agency founders from Apollo.

**Writes to `companies`:** 240 companies inserted (status=review)

**Write to `lists`:**
```
id:   list-001
name: "ROCI ICP - UK Agency Founders Aug 2026"
```

**Writes to `list_members`:** 240 rows (one per company)

---

## Day -12: AI Qualification

`qualify-list.ts` runs overnight.

**Writes to `enrichment_runs`:** 240 rows (one per company)
- 197 with icp_fit=true, icp_score >= 60
- 43 with icp_fit=false, icp_score < 60

**Updates to `companies`:**
- 197 rows → status='approved', icp_score set
- 43 rows → status='rejected'

---

## Day -10: Signal Ingestion

PredictLeads job runs for all 197 approved companies.

**Write to `jobs`:**
```
job_type:        predictleads
total_items:     197
successful_items: 194
status:          completed
```

**Writes to `signals`:** ~2,800 signals inserted across 194 companies
- job_posting signals: ~1,800
- funding_round signals: ~80
- executive_hire signals (from prospeo): ~920

---

## Day -8: Contact Sourcing + Verification

Prospeo pull for 197 companies.

**Writes to `contacts`:** 210 contacts (some companies have 2 contacts)

Email verification via Millionverifier:
**Writes to `email_verifications`:** 210 rows
- 185 status=valid
- 12 status=catch_all
- 13 status=invalid (these contacts excluded from campaign)

**Final contact count after filtering:** 197 deliverable contacts

---

## Day -7: List Scoring

`/list-quality-scorecard` runs.

**Write to `list_quality_scores`:**
```
list_name:                "ROCI ICP - UK Agency Founders Aug 2026"
total_rows:               197
grade:                    B
overall_score:            76
email_verification_score: 88    ← 88% verified
icp_fit_score:            82    ← all are approved ICP fit
catchall_density_score:   62    ← some UK catch-alls
top_issues:               ["12 catch-all emails (6%)",
                           "8 companies with 2 contacts each"]
```

Grade is B → green light to proceed.

---

## Day -5: Copywriting

`/campaign-copywriting` skill writes 3 sequences (one per approved strategy). For this campaign:

**Write to `email_sequences`:**
```
id:             seq-001
name:           "Bootstrapped Agency Founder — ROCI Profitability Angle"
campaign_strategy_id: (the approved strategy row)
value_prop_type: lead_magnet
overall_score:  82
status:         draft
```

**Writes to `email_sequence_steps`:** 4 rows
```
step 1: delay_days=0,  strategy_type=problem_sniffing, has_personalization=true
step 2: delay_days=3,  strategy_type=billboard,        has_personalization=false
step 3: delay_days=7,  strategy_type=creative_ideas,   has_personalization=true
step 4: delay_days=11, strategy_type=redirect,         has_personalization=false
```

---

## Day -4: Client Review Opens

**Write to `campaign_reviews`:**
```
sequence_id: seq-001
status:      pending_review
```

Scripts shared → `status = scripts_shared`, `scripts_share_url` set
List shared → `status = list_shared`, `list_share_url` set

Client feedback: "Email 3 is a bit too aggressive. Soften the tone."

**Update `campaign_reviews`:**
```
client_feedback: "Email 3 is a bit too aggressive..."
status:          feedback_received
```

Revision made to step 3 variants. Email sequence_steps updated.

**Update `campaign_reviews`:**
```
revision_notes: "Step 3 tone softened — removed direct competitor comparison"
revision_count: 1
status:         revisions_made
```

Client approves:
```
approved_by:  Eric M.
approved_at:  2026-09-01T14:00:00Z
status:       approved
```

**Update `email_sequences`:** `status = 'approved'`

---

## Day 0: Campaign Upload to Smartlead

`/smartlead-campaign-upload-public` runs.

**Write to `campaigns`:**
```
sequence_id:           seq-001
smartlead_campaign_id: 98765
name:                  "ROCI — Bootstrapped Agency Founder"
status:                draft      ← ALWAYS draft
total_leads:           197
```

**Writes to `campaign_leads`:** 197 rows (one per contact), all `status=queued`

**Client clicks Start in Smartlead** (this is external — no DB write from our system).

**Update `campaigns`:** `status = 'active'`, `launched_at = now()`

---

## Days 1-11: Emails Send

Smartlead sends the sequence to all 197 contacts over 11 days.

**Updates to `campaign_leads`** (as Smartlead webhooks fire):
- Each `status` moves: queued → sent → (replied or nothing)
- `steps_sent` increments for each email
- `last_sent_at` updated after each send

---

## Day 18: First Replies

After ~21 days of sending, reply data accumulates.

**`campaign_leads` state (sample):**
```
12 contacts: reply_classification = positive
 8 contacts: reply_classification = negative  
 3 contacts: reply_classification = auto_reply
174 contacts: no reply (status = sent, steps_sent = 4)
```

---

## Day 21: Results Analysis

`/positive-reply-scoring` reads `campaign_leads` for all positive replies.
`/experiment-design` calculates metrics.

**Metrics derived from `campaign_leads`:**
```
total_contacts:   197
emails_sent:      197 × 4 = 788
reply_rate:       12 / 197 = 6.1%   ← positive replies
positive_replies: 12
```

**Findings feed into next iteration:**
- Update `campaign_strategies` notes with what worked
- Open new review cycle for iteration 2 (`campaign_reviews` new row)

---

## Table Summary — Full Campaign Lifecycle

| Phase | Tables Written |
|-------|---------------|
| Idea | campaign_strategies |
| Planning | campaign_plans |
| List building | companies, lists, list_members |
| Qualification | enrichment_runs, companies (icp_score) |
| Signals | jobs, signals, enrichment_runs |
| Contacts | contacts, email_verifications, list_members |
| Scoring | list_quality_scores |
| Copy | email_sequences, email_sequence_steps |
| Review | campaign_reviews |
| Launch | campaigns, campaign_leads |
| Results | campaign_leads (reply data) |
