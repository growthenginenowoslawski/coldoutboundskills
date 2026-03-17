---
name: cold-email-copy-grader
description: Grades cold email campaign copy on a 0-100 scale using patterns from 1,000+ B2B campaigns. Paste your draft sequences and targeting info, get a score, risk flags, and full rewrites if your score is below 65. No database or API required.
---

# Cold Email Copy Grader

Grades cold email campaign copy on a 0-100 scale. Based on patterns extracted from analysis of 1,000+ real B2B cold email campaigns across dozens of industries.

Paste your draft email sequences and targeting details. Get back a score, risk flags, benchmark comparisons, and full copywriting rewrites when your score is below 65.

No database, API keys, or external tools required. Everything runs from the patterns and rules in this skill.

## When to Use This Skill

- Before launching a new cold email campaign
- Reviewing draft copy for a client
- Comparing two campaign approaches
- Getting data-driven copywriting recommendations
- Training new copywriters on what actually works

## How to Use

The user provides:
1. **Email sequences** (subject lines + body copy for each step)
2. **Targeting info** (job titles, industries, company size, geography)
3. **Any merge variables** they plan to use (e.g. `{{first_name}}`, `{{rating}}`, `{{savings}}`)

If any of the above is missing, ask for it before scoring.

### Quick Grade (Fast Path)

If the user just wants a fast gut check, skip the 4-agent analysis. Run a single-pass review hitting only these 5 factors:

1. **Subject line pattern** — question? lowercase? length?
2. **Body word count** — over/under 70?
3. **CTA type** — question, passive, or missing?
4. **Variable classification** — standard only, enriched, AI-targeted, or generic AI trap?
5. **Sequence count** — how many, any bump-only?

Output a letter grade (A through F), 3 bullet points (biggest strength, biggest risk, one fix), and a one-line recommendation. No full report, no rewrites. Takes 10 seconds instead of 2 minutes.

Use the quick grade when the user says things like "quick check", "gut check", "how does this look", or provides a single email without targeting details.

---

## Top 10 Cold Email Mistakes (Ranked by Impact)

A scannable cheat sheet. These are the most common patterns that kill campaigns, ranked by how much damage they do.

| # | Mistake | Impact | Fix |
|---|---------|--------|-----|
| 1 | **Generic AI first-line** ("I noticed your company does X...") | 71% poor rate, 4x worse than no personalization | Remove it. Use targeted product-focused AI or specific enriched data instead. |
| 2 | **No follow-up sequences** (1-2 emails only) | 2-5% top-performer rate vs 12% for 4-5 sequences | Add 4-5 sequences with value-add content, not bumps. |
| 3 | **Bump-only follow-ups** ("Just following up...") | 5% top-performer rate vs 13% for value-add | Each follow-up needs new information: case study, different angle, social proof. |
| 4 | **Generic greeting opener** ("Hope you're doing well...") | 4% top-performer rate vs 14% for observation | Open with something specific: an observation, a question, or enriched data. |
| 5 | **Passive CTA** ("If you're interested..." / "Feel free to...") | 50% fewer responses than direct asks | End with a direct question: "Would a 15-minute call next week work?" |
| 6 | **No personalization** (zero merge variables) | 2-3x worse than personalized emails | At minimum: `{{first_name}}` + `{{company_name}}`. Better: enriched data. |
| 7 | **Targeting individual contributors** (<30% decision-makers) | 4% top-performer rate vs 15% for Owner/CEO | Target Owner, CEO, Founder, VP, Director roles. |
| 8 | **Scattered industry targeting** (top industry <15%) | Generic messaging = lower relevance | Focus on 1-2 industries with tailored copy for each. |
| 9 | **Emails too long** (300+ words) | Lower completion rates | Target ~70 words. Cut to essentials. Use bullet points. |
| 10 | **No breakup email** | Miss fence-sitter responses | Add a "last attempt" closing email. 10% top-performer rate. |

---

## Sub-Agent Architecture

Launch these 4 agents in parallel for comprehensive analysis:

### Agent 1: Copywriting Pattern Analyzer
Analyzes subject lines, body structure, tone, and persuasion frameworks.

```
Focus areas:
- Subject line framework (question, curiosity, personalization)
- Body length (optimal: 50-150 words for initial email)
- Opening hook type (greeting, observation, question, value prop)
- CTA type (question, meeting, link, reply)
- Structure (paragraph count, readability)
```

### Agent 2: Variable & Personalization Analyzer
Detects and classifies merge variables, assesses personalization quality.

```
Focus areas:
- Extract all {{variable}} patterns
- Classify: standard vs enriched vs AI-targeted vs generic AI
- Calculate personalization density (variables per 100 words)
- Flag variables with hallucination risk
- Identify generic AI company observation patterns (critical anti-pattern)
```

### Agent 3: Subject Line & Sequence Specialist
Deep subject line analysis and sequence flow evaluation.

```
Focus areas:
- Pattern detection: question (best), lowercase start, ultra-short
- Personalization in subject ({{company_name}}, {{first_name}})
- Follow-up subject strategy (same thread vs new vs escalation)
- Sequence count and delay patterns
- Value-add progression vs bump-only follow-ups
- Breakup email presence
```

### Agent 4: Targeting & Audience Analyzer
Targeting quality assessment based on historical performance patterns.

```
Focus areas:
- Decision-maker concentration (Owner/CEO/Founder vs IC)
- Industry focus vs scatter
- Company size sweet spots (SMB outperforms enterprise)
- Copy-audience alignment (does the messaging match the audience?)
```

## Scoring Methodology

### Composite Score Formula

```
Predicted Success Score (PSS) =
  (0.40 x CopywritingScore) +
  (0.35 x TargetingScore) +
  (0.25 x VariableScore)
```

### CopywritingScore (40% weight, 0-100 points)

#### Subject Line Pattern (0-30 points)

| Pattern | Points | Evidence |
|---------|--------|----------|
| Question format (ends with ?) | +10 | 18% better response rate than standard |
| Lowercase start | +5 | 14% better than title case |
| Ultra-short (<30 chars) | +3 | Small positive signal |
| Personalization (`{{company_name}}`) | +5 | 2x higher top-performer rate |
| Fake reply (Re:/Fwd:) | -5 | Deceptive, damages trust |

**Subject Line Length Benchmarks:**

| Performance Tier | Avg Length | Median |
|-----------------|------------|--------|
| Top performers | 42 chars | 38 |
| Above average | 45 chars | 42 |
| Average | 47 chars | 44 |
| Below average | 51 chars | 48 |
| Poor | 54 chars | 52 |

Shorter subjects correlate with better performance.

#### Body Quality (0-40 points)

| Element | Points | Notes |
|---------|--------|-------|
| Clear CTA (question at end) | +10 | Must end with question or action |
| Observation opener | +5 | "I noticed..." pattern (14% top-performer rate) |
| Question opener | +5 | Engagement hook (11% top-performer rate) |
| Appropriate length (50-150 words) | +10 | Optimal range for sequence 1 |
| Follows P-A-S or A-I-D-A framework | +10 | Proven copywriting structures |

**Opening Hook Performance:**

| Pattern | Example | Top Performer % |
|---------|---------|-----------------|
| Observation | "I noticed {{company_name}}..." | 14% |
| Question | "Quick question about..." | 11% |
| Personalized | "As a {{job_title}} at..." | 10% |
| No greeting (direct pitch) | Straight to value | 6% |
| Generic greeting | "Hope you're doing well..." | 4% |

**CTA Performance:**

| Pattern | Example | Top Performer % |
|---------|---------|-----------------|
| Question CTA | "Would it make sense to chat?" | 13% |
| Soft ask | "Thoughts?" | 11% |
| Meeting request | "15 minutes next week?" | 9% |
| Reply request | "Let me know" | 6% |
| Link click | "Check this out: [link]" | 5% |

#### Structure (0-20 points)

| Element | Points | Notes |
|---------|--------|-------|
| Single clear ask per email | +10 | One CTA, not three |
| Readable paragraphs (2-3) | +5 | Not wall of text |
| Proper formatting | +5 | Line breaks, no HTML issues |

**Paragraph count performance:** 2-3 paragraphs = 12% top-performer rate. 6+ paragraphs = 4%.

#### Sequence Flow (0-10 points)

| Element | Points | Notes |
|---------|--------|-------|
| Value-add follow-ups | +5 | Not just "bumping" |
| Breakup email present | +3 | Final sequence closure |
| Logical escalation | +2 | Progression makes sense |

**Sequence Count Performance:**

| Sequences | Top Performer % |
|-----------|-----------------|
| 1 | 2% |
| 2 | 5% |
| 3 | 9% |
| 4 | 11% |
| 5 | 12% |
| 6+ | 8% |

Optimal: 4-5 sequences. Fewer than 3 consistently underperforms.

**Delay Between Sequences:**

| Delay | Top Performer % |
|-------|-----------------|
| 2-3 days | 11% |
| 4-5 days | 10% |
| 6-7 days | 9% |
| 1 day | 6% |
| 8+ days | 7% |

**Follow-up Content Types:**

| Type | Description | Top Performer % |
|------|-------------|-----------------|
| Value-add | New information, case study, insight | 13% |
| Breakup | "Last attempt", closing email | 10% |
| Referral | "Who else should I talk to?" | 8% |
| Bump | "Just following up..." | 5% |

### TargetingScore (35% weight, 0-100 points)

#### Audience Score (0-40 points)

| Decision-Maker % | Points |
|-----------------|--------|
| 80%+ | 40 |
| 60-79% | 30 |
| 40-59% | 20 |
| 30-39% | 10 |
| <30% | 0 |

**Decision-maker titles**: Owner, CEO, Founder, President, Partner, Principal, Managing Director, VP, Director, Head of

**Job Title Performance:**

| Level | Top Performer % |
|-------|-----------------|
| Owner/CEO/Founder | 15% |
| VP/Director | 10% |
| Manager | 7% |
| Individual Contributor | 4% |

#### Industry Focus (0-30 points)

| Top Industry % | Points |
|---------------|--------|
| 50%+ | 30 |
| 30-49% | 20 |
| 15-29% | 10 |
| <15% | 0 (scattered targeting) |

**Industry Performance (ranked):**

| Industry | Top Performer % |
|----------|-----------------|
| Restaurants / Food Service | 18% |
| Healthcare | 14% |
| Real Estate | 12% |
| Professional Services | 11% |
| Technology / SaaS | 9% |
| Manufacturing | 7% |
| Finance | 6% |

#### Copy-Audience Alignment (0-30 points)

| Alignment | Points | Description |
|-----------|--------|-------------|
| Strong | 30 | Copy specifically references industry/role pain points |
| Moderate | 20 | Generic but relevant value proposition |
| Weak | 10 | Mismatch between copy and audience |
| None | 0 | Copy doesn't address audience needs |

#### Company Size (informational)

| Headcount | Top Performer % |
|-----------|-----------------|
| 1-10 | 13% |
| 11-50 | 11% |
| 51-200 | 9% |
| 201-500 | 7% |
| 501-1,000 | 5% |
| 1,000+ | 3% |

SMB significantly outperforms enterprise in cold outreach.

### VariableScore (25% weight, 0-100 points)

This is the most counterintuitive component. Not all personalization is equal. Some types of AI personalization actively hurt campaigns.

#### Variable Classification

| Type | Examples | Top Performer % | Poor % |
|------|----------|-----------------|--------|
| Conditional Logic | `{{#if cuisine}}...{{else}}...{{/if}}` | 61.8% | 5.9% |
| Targeted Product-Focused AI | `{{savings}}`, `{{case_study_line}}`, `{{bullets}}` | 63.9% | 5.6% |
| Specific Enriched Data | `{{rating}}`, `{{town}}`, `{{competitor}}`, `{{review_line}}` | 44.2% | 4.7% |
| Standard Variables Only | `{{first_name}}`, `{{company_name}}`, `{{city}}` | 28.7% | 27.7% |
| Generic AI First-Line | `{{ai_generated_first_line}}`, `{{personalized_line}}` | **4.5%** | **71.0%** |

#### Scoring Matrix

| Standard Vars | Enriched/AI-Targeted | Points |
|---------------|---------------------|--------|
| 0 | 0 | 10 |
| 1 | 0 | 25 |
| 2 | 0 | 35 |
| 3+ | 0 | 45 |
| Any | 1 enriched | 55 |
| Any | 2+ enriched | 65 |
| Any | 1+ targeted AI | 75 |
| Any | 2+ targeted AI | 85 |
| Any | Conditional logic | 95 |
| Any | Generic AI first-line | **15** (PENALIZED) |

#### The Critical AI Personalization Finding

**Generic AI company observations have a 71% poor rate. They perform 4x worse than no personalization at all.**

This is the single most important finding in this skill. Most people think "more AI personalization = better." The data shows the opposite for the most common type of AI personalization.

**What FAILS (71% poor rate) - Generic AI Company Observations:**

These are AI-generated descriptions of what the prospect's company does, used as an opener:

| Pattern | Example | Why It Fails |
|---------|---------|--------------|
| AI summary of company | "I saw your company helps people with HVAC..." | Obvious, lazy, recipients know it's automated |
| Generic AI first-line | "I noticed {{company_name}} is doing great things..." | Empty flattery, no real insight |
| AI company description | "As a company that specializes in X..." | Anyone can scrape this, adds no value |

**DON'T write openers like:**
- "Hey {{first_name}}, I saw that {{company_name}} helps customers with [AI-generated description]..."
- "I noticed your company is doing great things in the [industry] space..."
- "As a leader in [AI-scraped industry], I thought you'd be interested..."

**What WORKS (63.9% top-performer rate) - Targeted Product-Focused AI:**

AI that calculates YOUR value for THEM, not describes THEIR company:

| Pattern | Example | Why It Works |
|---------|---------|--------------|
| Calculated value prop | "{{company_name}} could save {{savings}} annually..." | Concrete numbers, specific to them |
| Relevant case study | "Saw {{case_study_line}} - thought it might resonate..." | Real research, specific relevance |
| Customer type targeting | "For {{customer_type}} businesses like {{company_name}}..." | Tailored messaging by segment |

**DO write openers like:**
- "{{company_name}} could save {{savings}} annually by switching to [our approach]..."
- "Saw a case study about {{case_study_line}} - thought it might resonate..."
- "For {{customer_type}} businesses like {{company_name}}, we typically see..."

**What ALSO WORKS (44.2% top-performer rate) - Specific Enriched Data:**

Real, verifiable data points that prove you did actual research:

| Variable | Example Usage |
|----------|---------------|
| `{{rating}}` | "Saw {{company_name}} has a {{rating}}-star rating on Google..." |
| `{{review_line}}` | "Noticed '{{review_line}}' in one of your reviews..." |
| `{{competitor}}` | "Your competitor {{competitor}} recently started using..." |
| `{{town}}` | "Your {{cuisine}} restaurant in {{town}}..." |

**The Core Rule:** AI should generate SPECIFIC VALUE PROPS for them, not GENERIC OBSERVATIONS about them.

| Generic AI (71% poor) | Targeted AI (63.9% top performer) |
|-----------------------|----------------------------------|
| Describes THEIR company | Describes YOUR value for THEM |
| "I saw you help customers with X" | "Here's how we help companies like yours save X" |
| AI scrapes their website | AI calculates their potential benefit |
| 4x fewer positive replies than baseline | 57% more positive replies than baseline |

#### Spintax

| Spintax Present | Avg Positive Replies |
|----------------|---------------------|
| Yes | 105.6 |
| No | 27.3 |

Spintax campaigns get ~4x more positive replies because they're higher volume. Spintax itself is not a success factor - it's a volume indicator. Don't add spintax expecting it to improve reply rates.

#### Variable Density

| Variables per Email | Top Performer % |
|--------------------|-----------------|
| 0 | 4% |
| 1-2 | 8% |
| 3-4 | 11% |
| 5+ | 13% |

More personalization correlates with success, as long as it's the right kind.

### Score to Rating Mapping

| Score | Rating | What It Means |
|-------|--------|---------------|
| 80-100 | Excellent | Top-tier copy. Launch with confidence. |
| 65-79 | Above Average | Good copy. Minor improvements possible. |
| 50-64 | Average | Decent but won't stand out. Consider rewrites. |
| 35-49 | Below Average | Significant issues. Rewrites recommended. |
| 0-34 | Poor | Major problems. Do not launch without rewriting. |

## Risk Assessment

### Anti-Pattern Detection

Scan the copy for these patterns. Each flag adds to a risk score.

#### Critical Severity (+30 points each)

**GENERIC_AI_COMPANY_OBSERVATION**

Detection: AI-generated descriptions of what the prospect's company does, used as an opener.

```regex
{{(ai_generated|ai generated|firstline|first_line|personalized_line|ai_output|ai_summary)
```

Also flag if the opener follows the pattern: "I saw/noticed [company] does/helps/specializes in [AI-generated text]..."

Impact: 71% of campaigns using this pattern are poor performers. 4x fewer positive replies than baseline.

Recommendation: Remove entirely. Replace with targeted product-focused AI or specific enriched data, or just use standard variables with well-written copy.

---

**SPAM_CRITICAL**

Detection: Multiple spam trigger words.

```regex
(act now|limited time offer|free money|guaranteed results|no obligation|click here now|urgent action required|winner|congratulations)
```

Impact: Email likely filtered to spam.

---

#### Error Severity (+15 points each)

**FAKE_REPLY** - Subject starts with "Re:" or "Fwd:" on first email. Deceptive.

**NO_PERSONALIZATION** - Zero `{{variables}}` in any sequence. Generic emails perform 2-3x worse.

**MISSING_CTA** - Email doesn't end with question or clear ask. No clear next step reduces response rate by ~40%.

---

#### Warning Severity (+7 points each)

**SPAM_WARNING** - Single spam trigger word present. Review context.

**EMAIL_TOO_LONG** - Average word count >300 words. Optimal is ~70 words.

**EMAIL_TOO_SHORT** - First email <30 words. Not enough context.

**WEAK_CTA** - CTA exists but is passive: "if you're interested", "when you have time", "no rush", "feel free". Passive CTAs get 50% fewer responses than direct asks.

**INSUFFICIENT_FOLLOWUPS** - Fewer than 3 sequences.

**TOO_MANY_SEQUENCES** - More than 7 sequences. Diminishing returns after 5-6.

**LOW_DM_CONCENTRATION** - Decision-maker percentage <30%.

**SCATTERED_TARGETING** - Top industry <15% of total audience.

**ENTERPRISE_TARGET** - Primary target is 10,000+ employee companies. Enterprise has 50% lower success rate in cold outreach vs SMB.

**BUMP_ONLY_FOLLOWUPS** - Follow-ups only contain "following up", "checking in", "bumping" with no new value.

**NO_BREAKUP_EMAIL** - Final sequence doesn't indicate closure. Breakup emails often generate responses from fence-sitters.

**AI_WHOLE_EMAIL** - Variable appears to contain entire AI-generated email body. Flag but don't heavily penalize.

### Common Anti-Pattern Combinations

**"Spray and Pray"**
- SCATTERED_TARGETING + NO_PERSONALIZATION + BUMP_ONLY_FOLLOWUPS
- Typical outcome: Poor
- Fix: Focus targeting, add personalization, write value-add follow-ups

**"Robot Writer"**
- AI_WHOLE_EMAIL + NO_PERSONALIZATION + WEAK_CTA
- Typical outcome: Below Average
- Fix: Use AI for data points, not entire emails. Add human touches.

**"Enterprise Mistake"**
- ENTERPRISE_TARGET + EMAIL_TOO_LONG + TOO_MANY_SEQUENCES
- Typical outcome: Poor
- Fix: Target SMB, shorten emails, reduce to 4-5 sequences

**"Spam Risk"**
- SPAM_WARNING + FAKE_REPLY + TOO_MANY_SEQUENCES
- Typical outcome: Deliverability issues, poor engagement
- Fix: Clean copy, honest subjects, quality over quantity

**"AI Personalization Trap"**
- GENERIC_AI_COMPANY_OBSERVATION + basic variables only
- Typical outcome: Poor (71% poor rate, 4x fewer positive replies)
- Fix: Remove generic AI observations. Use specific enriched data or targeted product-focused AI instead. Describe YOUR value for THEM, not THEIR company.

### Risk Score Calculation

```
Risk Score = (critical_flags x 30) + (error_flags x 15) + (warning_flags x 7)
```

| Score | Level | Action |
|-------|-------|--------|
| 0-19 | Low | Proceed with minor improvements |
| 20-39 | Medium | Address issues before launch |
| 40-59 | High | Major revisions recommended |
| 60+ | Critical | Do not launch without fixing |

### Risk-Adjusted Score

| Risk Level | Score Adjustment |
|------------|-----------------|
| Low | 0 |
| Medium | -5 |
| High | -10 |
| Critical | -15 |

## Output Report Format

```markdown
# Cold Email Copy Grade Report

## Executive Summary
- **Predicted Score**: XX/100
- **Rating**: [Excellent / Above Average / Average / Below Average / Poor]
- **Risk Level**: [Low / Medium / High / Critical]

## Score Breakdown

| Factor | Score | Weight | Contribution |
|--------|-------|--------|--------------|
| Copywriting | XX/100 | 40% | XX pts |
| Targeting | XX/100 | 35% | XX pts |
| Variables | XX/100 | 25% | XX pts |
| **Total** | | | **XX/100** |

## Strengths
1. **[Strength]** - [Explanation with data]
2. **[Strength]** - [Explanation with data]

## Risk Factors
1. **[SEVERITY: FLAG_NAME]** - [Explanation + how to fix]
2. **[SEVERITY: FLAG_NAME]** - [Explanation + how to fix]

## Variable Analysis

| Variable | Type | Assessment |
|----------|------|------------|
| {{var}} | [standard/enriched/AI-targeted/generic AI] | [Good/Flag] |

## Benchmark Comparison

| Metric | This Campaign | Top Performers | Average |
|--------|--------------|----------------|---------|
| Subject pattern | [detected] | question | ultra_short |
| Subject length | XX chars | 42 chars | 47 chars |
| Body word count | XX words | 73 words | 71 words |
| Sequences | X | 4-5 | 3 |
| Paragraphs per email | X | 2-3 | 3 |

---

## Recommended Rewrites (if score < 65)

### Improved Subject Line
**Original**: [original]
**Rewritten**: [new version using question format + personalization]
**Why**: [data-driven reason]

### Improved Email Body (Sequence 1)
**Issues identified**: [list]

**Rewritten copy**:
[Full rewritten email]

**Key changes made**:
- [Change 1 with data backing]
- [Change 2 with data backing]

### Improved Follow-up Sequences
[Rewritten sequences 2-5 as needed]

### Predicted Score After Rewrites

| Factor | Before | After | Change |
|--------|--------|-------|--------|
| Copywriting | XX | XX | +XX |
| Targeting | XX | XX | +XX |
| Variables | XX | XX | +XX |
| **Total** | **XX** | **XX** | **+XX** |

---

## Quick Action Checklist
- [ ] [Most impactful fix]
- [ ] [Second most impactful fix]
- [ ] [Third fix]
```

## Rewrite Generation Guidelines

When score < 65, generate fresh rewrites based on these rules:

### Subject Line Rewrites
1. Convert to question format (18% improvement over standard)
2. Add `{{company_name}}` personalization (2x higher top-performer rate)
3. Consider lowercase start for casual tone (14% improvement)
4. Keep under 50 characters (shorter = better)
5. Never use "Re:" or "Fwd:" deceptively

### Body Rewrites
1. Target ~70 words (consistent across all performance tiers)
2. Open with observation using SPECIFIC data, not generic AI
3. End with clear question CTA
4. Use 2-3 paragraphs maximum
5. Follow P-A-S (Problem-Agitate-Solve) or direct observation-value-ask structure
6. NEVER use generic AI first-line variables - they have 71% poor rate
7. If enriched data is available, reference it specifically

### First-Line Rules

**USE - Targeted Product-Focused AI:**
- "{{company_name}} could save {{savings}} by [specific product benefit]..."
- "For {{customer_type}} businesses, we've seen [specific outcome]..."
- "Based on {{company_name}}'s {{metric}}, here's what we typically see..."

**USE - Specific Enriched Data:**
- "Saw {{company_name}} has a {{rating}}-star rating on Google..."
- "Noticed {{review_line}} in one of your reviews..."
- "Your {{cuisine}} restaurant in {{town}}..."

**NEVER USE - Generic AI Company Observations:**
- "I saw that {{company_name}} helps customers with {{ai_summary}}..."
- "I noticed your company is doing great things in [industry]..."
- "As a company that specializes in {{what_they_do}}..."

### Sequence Rewrites
1. Include 4-5 sequences total
2. Each follow-up adds new value (case study, different angle, social proof)
3. Never write bump-only follow-ups ("just following up...")
4. End with breakup email pattern ("last attempt" creates urgency)
5. Consider referral ask in sequence 3-4 ("Who else should I talk to?")
6. Space sequences 2-5 days apart
7. Use conditional logic for missing data: `{{#if variable}}...{{else}}...{{/if}}`

**Important**: Generate FRESH copy based on these patterns. Do not copy from examples verbatim.

## Quality Checklist

Before outputting the report, verify:
- [ ] All 4 sub-agents completed analysis
- [ ] Score components sum correctly with weights
- [ ] Risk flags align with detected patterns
- [ ] Risk adjustment applied to final score
- [ ] Rewrites follow question-format subject line pattern
- [ ] Rewrites use ~70 word target
- [ ] Rewrites don't include generic AI company observations
- [ ] Body word count is measured accurately (strip HTML tags first)
- [ ] Benchmark comparison uses correct reference numbers
- [ ] Quick action checklist is ordered by impact
