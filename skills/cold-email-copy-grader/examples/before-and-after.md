# Before & After: Full Worked Example

This is a real grading session. A mediocre SaaS campaign goes in, a full report comes out, and the rewrites transform it from a 38 to a 66.

---

## The Input

**Campaign**: SaaS Startup CEO Outreach

**Targeting**:
- Industry: Technology, Software
- Titles: CEO, Founder, CTO
- Headcount: 11-200 employees
- Geography: United States

**Sequence 1**

Subject: `Partnership opportunity`

Body:
> Hi {{first_name}},
>
> I wanted to reach out about a partnership opportunity that could benefit {{company_name}}.
>
> We help software companies like yours increase their conversion rates by an average of 35%. Our platform integrates seamlessly with existing tech stacks and has helped over 200 companies scale their growth.
>
> Some of our clients include [Company A], [Company B], and [Company C].
>
> Would you be open to a quick call to discuss?
>
> Best regards,
> [Name]

**Sequence 2** (Day 4)

Subject: `Following up`

Body:
> Hi {{first_name}},
>
> Just following up on my previous email about the partnership opportunity.
>
> Let me know if you'd like to chat.
>
> Best,
> [Name]

---

## The Grade Report

### Executive Summary
- **Predicted Score**: 38/100
- **Rating**: Below Average
- **Risk Level**: Medium (28 points)

### Score Breakdown

| Factor | Score | Weight | Contribution |
|--------|-------|--------|--------------|
| Copywriting | 35/100 | 40% | 14.0 pts |
| Targeting | 55/100 | 35% | 19.3 pts |
| Variables | 25/100 | 25% | 6.3 pts |
| **Total** | | | **39.5/100** |
| Risk adjustment | | | -1.5 pts |
| **Final Score** | | | **38/100** |

### Strengths

1. **Good targeting** - CEOs and Founders at 11-200 employee companies is solid SMB focus (11% top-performer rate for this headcount range)
2. **Social proof present** - Mentions client names and "200 companies" (if recognizable)
3. **Specific value prop** - "35% increase in conversion rates" is concrete

### Risk Factors

1. **WARNING: BUMP_ONLY_FOLLOWUP** (+7) - Sequence 2 adds zero value. "Just following up" is the #1 most ignored follow-up pattern (5% top-performer rate vs 13% for value-add).
2. **WARNING: INSUFFICIENT_FOLLOWUPS** (+7) - Only 2 sequences. Campaigns with 4-5 sequences have a 11-12% top-performer rate vs 5% for 2 sequences.
3. **WARNING: WEAK_CTA** (+7) - "Would you be open to a quick call to discuss?" is passive. Passive CTAs get 50% fewer responses than direct asks.
4. **WARNING: NO_BREAKUP_EMAIL** (+7) - No closure sequence. Breakup emails often convert fence-sitters (10% top-performer rate).

**Total Risk Score**: 28 (Medium) → -5 point adjustment

### Variable Analysis

| Variable | Type | Assessment |
|----------|------|------------|
| `{{first_name}}` | Standard | Basic - expected |
| `{{company_name}}` | Standard | Basic - expected |

**Variable Score**: 25/100 - Minimal personalization. Only 2 standard variables. No enriched or AI-targeted variables. Add `{{employee_count}}`, `{{funding_round}}`, or targeted AI variables to improve.

### Benchmark Comparison

| Metric | This Campaign | Top Performers | Average |
|--------|--------------|----------------|---------|
| Subject pattern | standard | question | ultra_short |
| Subject length | 22 chars | 42 chars | 47 chars |
| Body word count | 87 words | 73 words | 71 words |
| Sequences | 2 | 4-5 | 3 |
| Variables per email | 1 | 4+ | 3 |
| Opener type | generic ("I wanted to reach out") | observation (14%) | question (11%) |
| CTA type | passive | question (13%) | soft ask (11%) |

---

## The Rewrites

### Improved Subject Line

**Original**: `Partnership opportunity`

**Rewritten**: `quick question about {{company_name}}'s conversion funnel?`

**Why**: Question format performs 18% better than standard. Adding `{{company_name}}` doubles the top-performer rate. "Partnership opportunity" is a red flag phrase that triggers skepticism. Lowercase start adds another 14% lift.

---

### Improved Email Body (Sequence 1)

**Issues identified**:
- Generic "I wanted to reach out" opener (4% top-performer rate)
- Passive CTA
- Slightly long (87 words vs optimal 70)
- No personalization beyond first_name/company_name
- "Partnership" framing triggers skepticism

**Rewritten copy**:

> {{first_name}} - noticed {{company_name}} recently crossed [milestone / launched new feature].
>
> Quick question: how are you handling conversion optimization right now?
>
> We've helped 200+ software companies increase conversion by 35%. [Recognizable Client] saw results within 30 days.
>
> Would it make sense to share how they did it?
>
> [Name]

**Key changes**:
- Observation opener (14% top-performer rate vs 4% for generic greeting)
- ~58 words (under 70 target)
- Direct question CTA (13% top-performer rate)
- Removed "partnership" framing
- Added [milestone] placeholder for enriched variable

---

### Improved Sequence 2 (Day 3)

**Original**: Generic bump with no value

**Rewritten**:

> {{first_name}}, one thing I forgot to mention -
>
> [Similar SaaS Company] was in a similar spot - 10-15% trial-to-paid. After implementing our approach, they hit 28% in 6 weeks.
>
> Given {{company_name}}'s growth trajectory, curious if this resonates?
>
> [Name]

**Key changes**: Leads with new information (case study). Specific numbers. Connects back to their situation. Question CTA.

---

### New Sequence 3 (Day 6)

> {{first_name}}, different angle -
>
> Who at {{company_name}} typically handles conversion optimization?
>
> Happy to share our framework with whoever that is - no pitch, just the approach.
>
> [Name]

**Purpose**: Referral ask (8% top-performer rate). Shows respect for their time.

---

### New Sequence 4 (Day 10)

> {{first_name}}, I'll keep this brief -
>
> Been reaching out because I genuinely think {{company_name}} could see results like our other clients.
>
> If timing isn't right, totally understand. If anything changes, door's always open.
>
> Either way, wishing you success with {{company_name}}.
>
> [Name]

**Purpose**: Breakup email (10% top-performer rate). Often generates responses from fence-sitters.

---

### Predicted Score After Rewrites

| Factor | Before | After | Change |
|--------|--------|-------|--------|
| Copywriting | 35 | 72 | +37 |
| Targeting | 55 | 55 | 0 |
| Variables | 25 | 55 | +30* |
| **Total** | **38** | **66** | **+28** |

*Assumes adding 1-2 enriched variables like `{{recent_news}}` or `{{funding_round}}`

**Before**: 38/100 (Below Average)
**After**: 66/100 (Above Average)

---

### Quick Action Checklist

- [ ] Replace subject with question format + `{{company_name}}`
- [ ] Rewrite opener with observation hook (drop "I wanted to reach out")
- [ ] Change CTA to direct question
- [ ] Add 2 more sequences (referral + breakup)
- [ ] Add enriched variables if data is available
- [ ] Remove "partnership" framing
