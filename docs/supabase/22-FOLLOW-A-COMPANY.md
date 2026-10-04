# Follow a Company Through the Database

This document traces a single target company — Acme Digital Agency — from first mention to a cold email landing in the founder's inbox. Every table touched is shown in sequence with real-ish data.

## The Company: Acme Digital Agency

- A UK bootstrapped digital agency
- 35 employees
- Domain: acmedigital.co.uk
- Founder: Sarah Chen, Managing Director

---

## Step 1: Company is sourced (list-builder)

The list-builder skill scrapes Apollo/LinkedIn for UK agency founders. Acme Digital shows up.

**Write to `companies`:**
```
id:        cac84e2a-0001-0001-0001-000000000001
name:      Acme Digital Agency
domain:    acmedigital.co.uk
status:    review       ← all sourced companies start as "review"
source:    apollo
icp_score: null         ← not yet qualified
client_id: a29f5829-... ← Gramscode
created_at: 2026-08-14T09:00:00Z
```

**Write to `lists`:**
```
id:     list-001
name:   ROCI ICP - UK Agency Founders Aug 2026
client_id: a29f5829-...
source: apollo
```

**Write to `list_members`:**
```
list_id:    list-001
company_id: cac84e2a-0001-0001-0001-000000000001
contact_id: null
```

---

## Step 2: Company is qualified by AI (qualify-list)

The qualification job runs. It reads Acme Digital from `list_members`, calls Claude AI.

**Write to `enrichment_runs`:**
```
id:              run-001
company_id:      cac84e2a-...
client_id:       a29f5829-...
provider:        claude-haiku-4-5-20251001
task_type:       icp_qualification
status:          completed
input_tokens:    480
output_tokens:   130
cost_usd:        0.0000576
latency_ms:      920
attempt_number:  0
output_data:     {
  icp_fit: true,
  fit_score: 82,
  confidence: 0.87,
  reasoning: "35-person UK agency, runs monthly retainers,
              founder is MD — strong match for ROCI ICP."
}
```

**Update `companies`:**
```
icp_score: 82
status:    approved   ← company moves from review → approved
```

---

## Step 3: Signals ingested (PredictLeads)

The signal ingestion job runs for Acme Digital. PredictLeads returns:
- 2 open job postings (Backend Dev, Account Manager)
- No funding events

**Write to `jobs`:**
```
job_type:   predictleads
status:     completed
total_items: 1    ← 1 company batch
```

**Write to `signals`:**
```
-- Signal 1: Backend Developer job posting
id:               sig-001
client_id:        a29f5829-...
company_id:       cac84e2a-...
signal_type:      job_posting
signal_title:     Acme Digital Agency is hiring a Backend Developer
signal_strength:  65    ← standard for job_posting type
confidence:       0.80
occurred_at:      2026-08-28T00:00:00Z
expires_at:       2026-09-11T00:00:00Z  ← 14 days TTL
dedup_key:        (sha256 of provider event ID)
status:           active

-- Signal 2: Account Manager job posting
id:               sig-002
signal_title:     Acme Digital Agency is hiring an Account Manager
signal_strength:  65
occurred_at:      2026-08-30T00:00:00Z
expires_at:       2026-09-13T00:00:00Z
status:           active
```

---

## Step 4: Contact sourced (Prospeo)

The Prospeo pull finds Sarah Chen. Email verified via Millionverifier.

**Write to `contacts`:**
```
id:          con-001
company_id:  cac84e2a-...
first_name:  Sarah
last_name:   Chen
full_name:   Sarah Chen
job_title:   Managing Director
email:       sarah@acmedigital.co.uk
email_status: valid      ← Millionverifier confirmed
list_id:     list-001    ← direct FK
source:      prospeo
```

**Write to `list_members`:**
```
list_id:    list-001
company_id: null
contact_id: con-001
```

**Write to `email_verifications`:**
```
email:    sarah@acmedigital.co.uk
provider: millionverifier
status:   valid
result:   { "result": "ok", "free": false, "role": false }
```

---

## Step 5: List scored

The list quality scorecard runs across all 200 contacts in list-001.

**Write to `list_quality_scores`:**
```
list_id:                  list-001
grade:                    B
overall_score:            76
email_verification_score: 88
icp_fit_score:            79
catchall_density_score:   62  ← some UK catch-all domains
```

Acme Digital / Sarah Chen are counted in the verified and icp_fit dimensions.

---

## Step 6: Email sequence written

The copywriter runs `/campaign-copywriting` for the "Bootstrapped Agency Founder" angle.

**Write to `email_sequences`:**
```
id:       seq-001
client_id: a29f5829-...
name:     Bootstrapped Agency Founder — ROCI Profitability Angle
status:   approved
```

**Write to `email_sequence_steps`** (4 rows for seq-001):
```
step 1 (Day 0):  subject: "Agency margins aren't what you think"
                  body: "Hi {{first_name}}, ..."
step 2 (Day 3):  subject: "Quick follow-up"
step 3 (Day 7):  subject: "One data point on {{agency_name}}"
step 4 (Day 11): subject: "Closing the loop"
```

---

## Step 7: Client review

**Write to `campaign_reviews`:**
```
sequence_id:      seq-001
status:           pending_review
  → scripts_shared (scripts_share_url set)
  → feedback_received (client_feedback written)
  → revisions_made (revision_notes, revision_count = 1)
  → approved (approved_by = "Eric", approved_at = 2026-09-01)
```

---

## Step 8: Campaign upload to Smartlead

**Write to `campaigns`:**
```
sequence_id:           seq-001
smartlead_campaign_id: 12345  ← from Smartlead API
status:                draft   ← always draft; never auto-launched
total_leads:           197
```

**Write to `campaign_leads`:**
```
campaign_id: (campaigns.id)
contact_id:  con-001        ← Sarah Chen
company_id:  cac84e2a-...   ← Acme Digital
status:      queued
```

---

## Step 9: Email sent

Smartlead sends Day 0 email to sarah@acmedigital.co.uk.

**Update `campaign_leads`:**
```
status:      sent
steps_sent:  1
last_sent_at: 2026-09-03T09:15:00Z
```

---

## Step 10: Reply received

Sarah replies: "Yes, interested — can we book a call?"

**Update `campaign_leads`:**
```
status:               replied
reply_received_at:    2026-09-04T11:22:00Z
reply_classification: positive
```

The `/positive-reply-scoring` skill reads this row and routes Sarah into the meeting booking flow.

---

## Full Trail — All Rows Touched

| Table | Row | Key Value |
|-------|-----|-----------|
| companies | 1 | Acme Digital Agency |
| lists | 1 | ROCI ICP - UK Agency Founders Aug 2026 |
| list_members | 2 | company + contact both linked |
| enrichment_runs | 1 | AI qualification, cost=$0.00006 |
| jobs | 1 | signal ingestion job |
| signals | 2 | job_posting x2 |
| contacts | 1 | Sarah Chen, verified |
| email_verifications | 1 | valid |
| list_quality_scores | 1 | grade B, score 76 |
| email_sequences | 1 | sequence header |
| email_sequence_steps | 4 | Day 0/3/7/11 emails |
| campaign_reviews | 1 | approved after 1 revision round |
| campaigns | 1 | uploaded as draft |
| campaign_leads | 1 | queued → sent → replied (positive) |

**Total rows created for one company/contact:** ~20 rows across 14 tables.
