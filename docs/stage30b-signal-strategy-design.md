# Stage 30B — Signal Strategy & Provider Requirements Design

**Status:** READ-ONLY DESIGN. No schema changes. No provider calls. No production mutations.
**Produced:** 2026-09-13
**Based on:** Stage 30A.1 signal ingestion (job_openings + financing_events for 198 ROCI companies via PredictLeads)

---

## 0. Context from Stage 30A.1

Stage 30A ingested **page 1 of job_openings and financing_events** from PredictLeads for the 198 ROCI-qualified companies. Key architectural constraints:

- Only 2 of 4 confirmed PredictLeads modules are integrated: `job_openings` and `financing_events`
- `news_events` and `technology_detections` are confirmed in the PredictLeads API but **have no mapper yet**
- `executive_hire`, `expansion`, `website_change` as standalone signal types have **no confirmed PredictLeads module** — they may surface through `news_events` categories
- `rescoreCompany()` was explicitly excluded from Stage 30A; `account_intelligence` was not modified
- Signal weights are labelled `INITIAL_HYPOTHESIS_NOT_VALIDATED` throughout the codebase

---

## 1. Strategy A — Current Production ICP: UK Creative/Marketing/Design Agencies

**Client:** ROCI Agency  
**Persona they sell to:** Founders, MDs, and Creative Directors of UK creative/digital/branding agencies (5–50 staff), referral-dependent with unpredictable pipelines

---

### 1.1 Top 15 Commercially Meaningful Signals

| # | Signal Name | Signal Type (current taxonomy) | Business Event |
|---|-------------|-------------------------------|----------------|
| 1 | BD/Growth Role Hire | `job_posting` | Agency posts a "Head of New Business," "Business Development Manager," or "Growth Director" opening |
| 2 | Delivery Staff Expansion | `job_posting` | Agency hires designers, account managers, or project managers, expanding headcount without a confirmed revenue increase |
| 3 | Leadership Change | `executive_hire` | Founder steps back or a new MD/CEO/Director joins — resets vendor relationships |
| 4 | Agency Rebrand / New Website | `website_change` | Agency relaunches its own brand identity or website — post-rebrand outreach phase |
| 5 | Agency wins industry award | `award` | D&AD, Drum, BIMA, Cannes Lions — public credibility peak, opens the door for peer-to-peer outreach |
| 6 | New service offering launch | `product_launch` | Agency announces a new capability (e.g., "we now do TikTok ads") — means they're trying to win new clients in that vertical |
| 7 | Agency press coverage / interview | `news_mention` | Agency founder featured in trade press, or agency mentioned in marketing press |
| 8 | Strategic partnership announced | `partnership` | Agency announces a tech or media partner — signals external growth ambitions |
| 9 | Agency expansion (new office/city) | `expansion` | Agency opens a second location — revenue pressure to fill new capacity |
| 10 | Investment / grant received | `funding_round` | Innovate UK grant, angel investment, or private equity — new budget available |
| 11 | Technology stack adoption | `technology_change` | Agency adopts a new CRM, project management, or analytics tool — indicates operational scaling |
| 12 | Competitor / market mention | `competitor_mention` | Agency mentioned alongside outbound/BD competitors in industry content |
| 13 | Agency hiring a Strategist / Planner | `job_posting` | Senior creative or strategy hire — signals agency is pitching up-market, needs more leads |
| 14 | Founder speaking at an event | `news_mention` | Founder at a conference — public positioning signals desire for new business |
| 15 | Loss of major client (public signal) | `news_mention` | Rare — sometimes agencies publicly note losing a major retainer in trade press or LinkedIn |

---

### 1.2 Signal Definitions

#### Signal 1 — BD/Growth Role Hire
- **What event:** Agency posts a public job opening for a BD, account growth, or sales function
- **Why buying intent:** Direct, unambiguous signal. The agency knows it needs to build pipeline. It is either failing to do it in-house or trying to — ROCI can intercept with a cheaper, faster alternative
- **Classification:** DIRECT BUYING SIGNAL (tier 1)
- **Minimum evidence required:** Job title must contain "New Business," "Business Development," "Growth," or "Account Director (New Business)" in the job posting title
- **Desired TTL:** 14 days from posting date (role is filled or delisted; signal value decays fast)
- **Signal strength (proposed revision):** 85 (currently mapped as generic `job_posting` at 50 — needs role-level filter)
- **Confidence requirement:** 0.8 minimum (provider-ID tier dedup; title match on structured field)
- **Decision-maker / persona:** Founder / MD (the person who posted the role is also the buyer for ROCI)
- **Recommended sales action:** Outreach within 72 hours of detection; lead with "you're trying to build BD capability — here's why outsourcing it is faster and cheaper"
- **Corroboration:** Signal 2 (delivery hires) in same 90-day window boosts score — agency is scaling headcount and needs revenue
- **False positive risk:** Agency has a dedicated BD director and is backfilling; agency BD role is for a B2C brand, not an agency

#### Signal 2 — Delivery Staff Expansion
- **What event:** Agency hires designers, developers, content producers, account managers
- **Why buying intent:** New delivery headcount without a confirmed revenue increase = pipeline anxiety. ROCI's entire value proposition addresses this
- **Classification:** LEADING INDICATOR (tier 2)
- **Minimum evidence required:** Job title in creative/delivery function; hiring within 60 days
- **Desired TTL:** 14 days
- **Signal strength (proposed):** 55 (above current baseline of 50 because it's specific to this ICP)
- **Confidence requirement:** 0.6
- **Decision-maker / persona:** Founder / MD
- **Recommended sales action:** "I noticed you're growing your team — are you finding enough work to keep everyone busy?"
- **Corroboration:** Stronger when paired with Signal 1 (hiring BD AND delivery simultaneously = very strong buying intent)
- **False positive risk:** Replacement hire (someone left); freelancer hire, not permanent headcount

#### Signal 3 — Leadership Change
- **What event:** New MD, CEO, or Director joins the agency
- **Why buying intent:** New leaders reset vendor relationships in the first 90 days. They often scrutinize pipeline and want quick wins. The previous agency-founder dynamic was personal; new leadership is rational
- **Classification:** DIRECT BUYING SIGNAL (tier 1)
- **Minimum evidence required:** LinkedIn job change confirmation OR news announcement; seniority = C-suite or Director; company domain match
- **Desired TTL:** 30 days (the first 30 days of a new leader's tenure is the highest-value window)
- **Signal strength (proposed):** 80
- **Confidence requirement:** 0.75
- **Decision-maker / persona:** The NEW executive is the target — they are not yet loyal to existing vendors
- **Recommended sales action:** "Congrats on the new role — are you planning to review your new business approach in Q1?"
- **Corroboration:** Strongly corroborated by Signal 4 (rebrand follows leadership change frequently)
- **False positive risk:** Internal promotion from existing team; departure announcement misclassified as hire; freelance interim role

#### Signal 4 — Agency Rebrand / Website Change
- **What event:** Agency relaunches its website, name, or brand identity
- **Why buying intent:** Post-rebrand, agencies want new clients in new sectors. Their old referral network may not fit the new positioning. They are actively in "new business" mode but lack the infrastructure
- **Classification:** DIRECT BUYING SIGNAL (tier 1)
- **Minimum evidence required:** Website technology or design change detected + recency within 90 days
- **Desired TTL:** 60 days
- **Signal strength (proposed):** 65
- **Confidence requirement:** 0.6
- **Decision-maker / persona:** Founder / Creative Director
- **Recommended sales action:** Reference the rebrand by name; connect it to the need to reach new audiences
- **Corroboration:** Stronger with Signal 3 (leadership change triggered rebrand) or Signal 6 (new service launch)
- **False positive risk:** Minor content update (blog post, copy tweak) misclassified as a rebrand; CMS template swap with no strategic intent

#### Signal 5 — Industry Award Win
- **What event:** Agency wins or is shortlisted for D&AD, The Drum Awards, BIMA, Cannes Lions, or similar
- **Why buying intent:** Award-winning agencies are at a peak credibility moment. They are actively pitching for higher-value clients. A "you won — let's make sure you have the pipeline to match your profile" angle resonates
- **Classification:** LEADING INDICATOR (tier 2)
- **Minimum evidence required:** Named award mention with agency name and outcome (win or shortlist)
- **Desired TTL:** 180 days (award credibility window is long)
- **Signal strength (proposed):** 50
- **Confidence requirement:** 0.7
- **Decision-maker / persona:** Founder / Creative Director (awards are personal to agency leaders)
- **Recommended sales action:** Lead with congratulations; connect to the "new business ready for the profile you've built" angle
- **Corroboration:** Standalone; does not corroborate other signals meaningfully
- **False positive risk:** Agency shortlisted but did not win; award is niche with no brand recognition; agency is well-established and has outbound already

#### Signal 6 — New Service Offering Launch
- **What event:** Agency announces it now offers a new capability (e.g., AI content, performance marketing, TikTok, CRO)
- **Why buying intent:** A new service = the agency is trying to penetrate new client segments it wasn't in before. Their existing referral network does not know about the new capability. They need outbound
- **Classification:** DIRECT BUYING SIGNAL (tier 1)
- **Minimum evidence required:** Announcement via press/website/blog; service must be net-new (not a renamed existing capability)
- **Desired TTL:** 60 days
- **Signal strength (proposed):** 70
- **Confidence requirement:** 0.65
- **Decision-maker / persona:** Founder / MD / Head of New Business
- **Recommended sales action:** Name the new service explicitly; ask if they have a pipeline of clients for this new offering
- **Corroboration:** Corroborates Signal 4 (rebrand often accompanies new service) and Signal 1 (hiring to deliver new service)
- **False positive risk:** Internal reorg of services without genuine new capability; announcement of a pilot with no go-to-market intent

#### Signal 7 — Agency Press Coverage
- **What event:** Agency founder or agency featured in trade press (The Drum, Campaign, Marketing Week, Econsultancy)
- **Why buying intent:** Agencies that get press coverage are doing BD-adjacent work — they're building their brand. This indicates desire to grow and attract clients, but likely without a systematic outbound process
- **Classification:** LEADING INDICATOR (tier 2)
- **Minimum evidence required:** Named mention in a recognised trade publication
- **Desired TTL:** 7 days (news is ephemeral; relevance window is very short)
- **Signal strength (proposed):** 40
- **Confidence requirement:** 0.6
- **Decision-maker / persona:** Founder / Creative Director
- **Recommended sales action:** Reference the article; make it feel like a warm introduction
- **Corroboration:** Weak standalone signal; becomes more useful when combined with Signal 5 (award) or Signal 6 (new service)
- **False positive risk:** Agency was mentioned critically; agency already has a full BD team; article is about a different company with a similar name

#### Signals 8–15
- **Signal 8 (Partnership):** LEADING INDICATOR. Agency partners with a tech company or media platform — indicates growth strategy. TTL 90d. Low coverage.
- **Signal 9 (Expansion):** LEADING INDICATOR. New office signals revenue pressure to fill. TTL 90d. Moderate coverage in news_events.
- **Signal 10 (Funding/Grant):** DIRECT SIGNAL when it occurs, but near-zero coverage for 5-50 staff UK agencies. Most do not raise venture funding. Innovate UK grants are possible but rare.
- **Signal 11 (Tech Change):** WEAK LEADING INDICATOR. Adopting new project management or analytics tool suggests scaling. TTL 90d. Uncertain coverage.
- **Signal 12 (Competitor mention):** WEAK INDICATOR. Only useful if the competitor mention context implies awareness of outbound. TTL 14d.
- **Signal 13 (Senior Strategy Hire):** LEADING INDICATOR. Agency pitching up-market = needs more leads. TTL 14d.
- **Signal 14 (Founder speaking):** WEAK LEADING INDICATOR. Public positioning = new business desire. TTL 7d.
- **Signal 15 (Client loss):** DIRECT BUYING SIGNAL but extremely rare as a public, detectable event. Coverage is essentially zero.

---

### 1.3 Critical Weight Mismatch Finding

The current `ICP_RELEVANCE` weights (`opportunity-scoring.ts:29`) were designed for a **generic B2B SaaS motion**, not for ROCI's specific ICP:

| Signal Type | Current Weight | Proposed for Strategy A | Reason for Change |
|-------------|---------------|------------------------|-------------------|
| `funding_round` | 1.00 | 0.35 | UK creative agencies (5-50 staff) almost never raise VC. This signal will fire ≤2% of the time. Overweighted. |
| `executive_hire` | 0.90 | 0.85 | Correct weight — leadership change is high-intent. Keep approximately. |
| `job_posting` | 0.60 | **0.90 (BD role) / 0.60 (delivery role)** | BD-role job posting is the single most predictive signal for this ICP. Needs role-level classification. |
| `news_mention` | 0.30 | 0.45 | Trade press coverage matters more for agency BD than generic B2B. |
| `award` | 0.25 | 0.50 | Agency awards are commercially meaningful (D&AD win opens conversation). |
| `website_change` | 0.20 | 0.65 | Agency rebrand is a strong buying signal — not a weak website tweak. |
| `product_launch` | 0.70 | 0.70 | New service launch remains appropriate. Keep. |
| `expansion` | 0.80 | 0.65 | Expansion matters less for a 5-50 staff agency — fewer open a second office. |

**NOTE:** These are proposed revisions, not validated weights. Existing weights remain hypotheses (`INITIAL_HYPOTHESIS_NOT_VALIDATED` label preserved). Do not change weights until at least one full campaign cycle of outcome data exists.

---

## 2. Strategy B — Proposed Commercial Roofing ICP: Regional Commercial Flat-Roofing Contractors

**Hypothetical client:** A regional commercial flat-roofing contractor  
**Their target accounts:** Owners/operators/facilities managers of warehouses, logistics hubs, and industrial properties in their geographic service area  
**What they sell:** Commercial flat roof installation, repair, and maintenance contracts

---

### 2.1 Top 15 Commercially Meaningful Signals

| # | Signal Name | Signal Type (current taxonomy) | Business Event |
|---|-------------|-------------------------------|----------------|
| 1 | Building age / roof age threshold | **(no current type — property data)** | Commercial property built 15-25+ years ago; flat roof at or past replacement lifecycle |
| 2 | Building permit for renovation | **(no current type — permit data)** | Property owner files a permit for structural renovation, re-roofing, or building upgrade |
| 3 | New warehouse lease / facility opening | `expansion` | Logistics or manufacturing company announces a new facility — new building, new roof |
| 4 | Post-storm damage / weather event | **(no current type — weather + news)** | Severe weather (hail, wind) in the region hits industrial zones |
| 5 | Facilities Manager / Operations Manager hire | `job_posting` | Property company hires an FM or Property Manager — they will conduct a building audit |
| 6 | Commercial property acquisition / M&A | `expansion` + `news_mention` | Company acquires a warehouse or industrial estate — new owner audits building condition |
| 7 | Business expansion into new region | `expansion` | Logistics company opens a new distribution hub — needs a flat-roofing contractor immediately |
| 8 | Funding round for logistics / industrial company | `funding_round` | VC-backed logistics startup raises capital for new facilities |
| 9 | EPC / energy efficiency mandate news | **(no current type — regulatory)** | UK government EPC-C compliance deadline drives building upgrades (roof insulation counts) |
| 10 | Construction start / planning permission granted | **(no current type — planning data)** | New industrial development breaks ground — specification stage for roofing |
| 11 | Insurance renewal / risk audit period | **(no current type — financial cycle)** | Commercial insurance renewal typically triggers building condition assessment |
| 12 | Facilities operations job posting (any) | `job_posting` | Company is building an in-house facilities team — FM will assess building condition |
| 13 | Industrial park announcement | `news_mention` + `expansion` | Developer announces new industrial estate development |
| 14 | Competitor mention (other roofer wins contract) | `competitor_mention` | Another commercial roofer publicly wins a contract — reveals active market demand |
| 15 | Financial distress / cost-efficiency push | `news_mention` | Company announces cost reduction program — maintenance contracts can be presented as lower TCO vs. emergency repair |

---

### 2.2 Signal Definitions (abbreviated for key signals)

#### Signal 1 — Building Age / Roof Age Threshold
- **What event:** Commercial flat roof reaches 15-25 year lifecycle threshold (the average replacement cycle for EPDM/modified bitumen flat roofs in the UK)
- **Why buying intent:** This is the single strongest predictor of commercial roofing demand. Flat roofs have a predictable lifecycle. A 20-year-old roof is a statistical certainty for replacement within 5 years. This is the roofing equivalent of `funding_round` — the highest-conviction signal.
- **Classification:** DIRECT BUYING SIGNAL (tier 1)
- **Minimum evidence required:** Property build date from public records; property type confirmed as industrial/warehouse
- **Desired TTL:** 365 days (this is a structural fact, not a time-sensitive event)
- **Signal strength (proposed):** 90
- **Confidence requirement:** 0.85 (requires authoritative property data source)
- **Decision-maker / persona:** Property Owner, Facilities Director, Operations Director
- **Recommended sales action:** "Your facility at [address] was built in [year]. Flat roofs at that age typically need inspection — would a free condition survey be useful?"
- **Corroboration:** Corroborated by Signal 2 (permit filed) or Signal 4 (storm damage) in same window
- **False positive risk:** Building has been re-roofed since original construction; property data inaccurate; building is leasehold (tenant has no purchasing authority)
- **DATA GAP:** **This signal does NOT exist in PredictLeads. Requires a specialist property data provider** (Valuation Office Agency data, EPC register, Land Registry for UK; no current provider integration)

#### Signal 2 — Building Permit for Renovation
- **What event:** Property owner files a planning application or building permit for structural work
- **Why buying intent:** Renovation permits frequently accompany or trigger roofing work. The permit process reveals intent to spend on the building
- **Classification:** DIRECT BUYING SIGNAL (tier 1)
- **Minimum evidence required:** Local planning authority (LPA) permit record; property type = industrial/warehouse; work description includes structure or envelope
- **Desired TTL:** 90 days (construction decisions are made quickly once a permit is approved)
- **Signal strength (proposed):** 85
- **DATA GAP:** **Not in PredictLeads. Requires local UK planning authority data integration** (Planning Portal API, individual LPA feeds). Coverage is patchy across UK councils.

#### Signal 3 — New Warehouse Lease / Facility Opening
- **What event:** A logistics, manufacturing, or distribution company announces a new facility
- **Why buying intent:** New buildings need new roofs. The specification decision is made during construction or immediately after occupancy
- **Classification:** DIRECT BUYING SIGNAL (tier 1)
- **Minimum evidence required:** Named company + named facility + industry = logistics/manufacturing/industrial
- **Desired TTL:** 60 days
- **Signal strength (proposed):** 80
- **DATA GAP for TIMING:** PredictLeads `news_events` may surface this via press releases. Coverage is uncertain for regional/SME logistics companies. **Partially supported by current system; not yet integrated.**

#### Signal 4 — Post-Storm Damage / Weather Event
- **What event:** Severe weather event (hail storm, sustained high winds) hits a geographic region where the roofing contractor operates
- **Why buying intent:** Emergency flat roof repair and proactive post-storm assessment is the highest-urgency trigger. Clients call immediately after damage
- **Classification:** DIRECT BUYING SIGNAL (tier 1, time-critical)
- **Minimum evidence required:** Confirmed weather event (Met Office/Environment Agency data) in the contractor's service area; wind speed or hail threshold exceeded
- **Desired TTL:** 7 days (emergency window is very short)
- **Signal strength (proposed):** 95 (the most time-critical signal type for roofing)
- **DATA GAP:** **Completely absent from the current system.** Requires weather API integration (Met Office DataPoint, Dark Sky). No existing signal type maps to this. New signal type would be needed: `weather_event`.

#### Signal 5 — Facilities Manager Hire
- **What event:** Industrial or logistics company hires a Facilities Manager, Property Manager, or Head of Operations
- **Why buying intent:** A new Facilities Manager will audit all building assets in their first 90 days. This is a reliable trigger for maintenance contract conversations
- **Classification:** LEADING INDICATOR (tier 2)
- **Minimum evidence required:** Job title = Facilities Manager, Property Manager, Operations Director, or Health & Safety Manager; company = industrial/logistics/warehouse sector
- **Desired TTL:** 30 days (new FM sets their agenda quickly)
- **Signal strength (proposed):** 70
- **Confidence requirement:** 0.7
- **PredictLeads support:** YES — via `job_openings` module; currently integrated
- **False positive risk:** Facilities manager for a retail/office building (not industrial); temp/contract role with no purchasing authority

#### Signals 6–15 (abbreviated)
- **Signal 6 (Property acquisition):** Strong buying signal but requires M&A/CoStar data not in PredictLeads. `expansion` + `news_mention` partially capture it.
- **Signal 7 (Business expansion):** Partially captured via `expansion` type in PredictLeads `news_events`.
- **Signal 8 (Funding round):** Low coverage for industrial SMEs; more useful for VC-backed logistics startups.
- **Signal 9 (EPC mandate):** Regulatory signal with no current provider. High strategic value but requires regulatory data integration.
- **Signal 10 (Construction start):** Requires planning authority data; not in PredictLeads.
- **Signal 11 (Insurance renewal):** Private financial data; not detectable via any public provider.
- **Signal 12 (Facilities job posting):** Supported via `job_openings`; partially available.
- **Signal 13 (Industrial park):** Partially via `news_events`; coverage uncertain.
- **Signal 14 (Competitor win):** Very rare as a detectable public event.
- **Signal 15 (Financial distress):** Partially via `news_mention`; weak signal.

---

### 2.3 Fundamental Signal Architecture Gap for Strategy B

**The current 11 signal types were designed for company business events (hiring, funding, tech changes).** Commercial roofing demand is driven by **physical property events** (building age, weather, permits) and **structural economic patterns** (maintenance cycles, insurance audits, EPC compliance).

Of the 15 most commercially meaningful signals for Strategy B, **only 3–4 can be partially addressed by the current system** (job_posting for FM hires, expansion for new facilities, news_mention for property announcements). The highest-conviction signals (building age, permits, storm damage, EPC mandates) require entirely new provider categories that don't exist in the current stack.

---

## 3. Provider Capability Matrix

**Legend:**
- ✓ = Currently implemented in codebase
- ⚠ = PredictLeads module confirmed in codebase, but no mapper yet written
- ? = Uncertain whether PredictLeads has this module (not confirmed in codebase)
- ✗ = Not in PredictLeads; requires different provider
- PROPOSED = Future capability only; not yet designed or implemented

### 3.1 Strategy A — UK Creative Agencies

| Signal | Required freshness | Required coverage | Possible source | Current provider support | Gap |
|--------|-------------------|-------------------|-----------------|--------------------------|-----|
| BD/Growth role hiring | ≤ 14 days | UK agencies 5-50 staff | PredictLeads job_openings | ✓ (ingested, but no role filter) | Need role-title filter on job_posting; not a provider gap |
| Delivery staff hiring | ≤ 14 days | UK agencies 5-50 staff | PredictLeads job_openings | ✓ (ingested) | Role classification needed |
| Executive / leadership change | ≤ 30 days | MD/CEO/Director level | PredictLeads news_events (category: executive_hire?) | ⚠ news_events not integrated; standalone exec module uncertain | Medium gap — need news_events mapper |
| Agency rebrand / website change | ≤ 60 days | UK agencies | PredictLeads technology_detections OR news_events | ⚠ technology_detections not integrated | Medium gap — mapper needed |
| Award win | ≤ 180 days | UK trade awards | PredictLeads news_events | ⚠ news_events not integrated | Medium gap — need news category filter for awards |
| New service offering | ≤ 60 days | Public announcements | PredictLeads news_events (category: product_launch) | ⚠ news_events not integrated | Medium gap |
| Trade press mention | ≤ 7 days | The Drum, Campaign, MW | PredictLeads news_events | ⚠ news_events not integrated | Medium gap |
| Strategic partnership | ≤ 90 days | Public announcements | PredictLeads news_events (category: partnership) | ⚠ news_events not integrated | Medium gap |
| Agency expansion | ≤ 90 days | Office/location announcements | PredictLeads news_events (category: expansion?) | ⚠ news_events not integrated | Medium gap |
| Investment / grant | ≤ 90 days | Very rare for this ICP | PredictLeads financing_events | ✓ (ingested) | Coverage gap — UK agencies 5-50 staff rarely raise VC |
| Technology change | ≤ 90 days | CRM/PM tool adoptions | PredictLeads technology_detections | ⚠ technology_detections not integrated | Medium gap |

**Coverage concern for Strategy A:** PredictLeads' coverage of **UK SME companies with 5-50 staff** is unknown. PredictLeads is stronger on US companies and on companies with significant web presence and recruitment activity. Many UK boutique creative agencies may have insufficient public footprint to generate consistent job_opening data. This is a **live data question** that only the Stage 30A ingestion results can answer — specifically, what percentage of the 198 ROCI companies received at least one job_posting signal.

### 3.2 Strategy B — Commercial Roofing → Warehouses/Logistics/Industrial

| Signal | Required freshness | Required coverage | Possible source | Current provider support | Gap |
|--------|-------------------|-------------------|-----------------|--------------------------|-----|
| Building age / roof age | Evergreen (structural fact) | All UK commercial properties | VOA, Land Registry, EPC Register, CoStar | ✗ No current integration | **CRITICAL GAP — new provider category required** |
| Building permit | ≤ 90 days | Planning Portal / LPA APIs | UK Planning Portal API, local council portals | ✗ No current integration | **CRITICAL GAP — new provider + new signal type** |
| New facility opening | ≤ 60 days | Public press, CoStar | PredictLeads news_events + CoStar | ⚠ PredictLeads partial; CoStar not integrated | Major gap |
| Post-storm / weather event | ≤ 7 days (time-critical) | Met Office, weather APIs | Met Office DataPoint, Dark Sky / Tomorrow.io | ✗ No current integration | **CRITICAL GAP — new signal type `weather_event` needed** |
| Facilities Manager hire | ≤ 30 days | UK industrial companies | PredictLeads job_openings | ✓ (ingested, but no sector filter for industrial) | Sector filter needed; same medium gap as Strategy A role filter |
| Property acquisition / M&A | ≤ 90 days | Companies House, CoStar | PredictLeads news_events, CoStar | ⚠ partial | Major gap |
| Business expansion to new location | ≤ 60 days | Public announcements | PredictLeads news_events | ⚠ not integrated | Medium gap |
| Funding round (logistics startup) | ≤ 90 days | VC-backed logistics only | PredictLeads financing_events | ✓ (ingested) | Narrow ICP subset only |
| EPC compliance mandate | Regulatory (known dates) | UK government data | UK legislation / Environment Agency | ✗ No current integration | **CRITICAL GAP — regulatory data** |
| Construction start / planning approval | ≤ 60 days | Planning Portal | Planning Portal API | ✗ No current integration | **CRITICAL GAP** |
| Insurance renewal cycle | Evergreen (annual cycle) | Not publicly available | Not available via any public provider | ✗ Impossible via current approach | Structural gap — private financial data |
| Industrial park development | ≤ 90 days | Trade/property press | PredictLeads news_events | ⚠ not integrated | Medium gap |

---

## 4. Assessment of the Current 11 Signal Types

### 4.1 For Strategy A (UK Creative Agencies)

The 11 signal types are **sufficient in taxonomy** but carry a **critical weight miscalibration** for this specific ICP.

| Signal Type | Fit for Strategy A | Coverage expectation | Issue |
|-------------|-------------------|---------------------|-------|
| `job_posting` | HIGH FIT | HIGH — agencies actively recruit publicly | **UNDERWEIGHTED** (0.60 ICP relevance). The most detectable, highest-intent signal for this ICP is scored the lowest after `website_change`. Needs role-level differentiation: a BD-role posting should score ~0.90; a delivery-role posting ~0.60 |
| `executive_hire` | HIGH FIT | MODERATE — senior hires sometimes announced; not always via PredictLeads | Weight (0.90) is appropriate. Module not yet integrated. |
| `website_change` | HIGH FIT | MODERATE — technology_detections may detect CMS/tech stack changes, not brand relaunches | Weight (0.20) is too low. An agency rebrand is a strong signal. Need to distinguish rebrand from minor changes. |
| `news_mention` | MODERATE FIT | MODERATE — trade press coverage of UK agencies in PredictLeads uncertain | Weight (0.30) is too low for an ICP where press coverage is a proxy for BD ambition. |
| `award` | MODERATE FIT | LOW-MODERATE — UK agency awards may not all be indexed | Weight (0.25) is too low. Agency award win is commercially meaningful. |
| `product_launch` | MODERATE FIT | MODERATE — agencies announcing new services via press | Weight (0.70) is appropriate. |
| `expansion` | LOW-MODERATE FIT | LOW — most 5-50 staff agencies don't open new offices | Weight (0.80) is too high for this ICP specifically. |
| `funding_round` | LOW FIT | VERY LOW — UK boutique agencies rarely raise VC | Weight (1.00) is dramatically wrong for this ICP. The type is correct in taxonomy but almost never fires for 5-50 staff UK agencies. Innovate UK grants are possible but rare and small. |
| `partnership` | LOW-MODERATE FIT | LOW — agency partnerships are infrequently announced publicly | Weight (0.65) is reasonable but coverage may be near zero. |
| `technology_change` | LOW FIT | UNCERTAIN — PredictLeads may detect SaaS adoption; unclear if this is meaningful for a creative agency | Weight (0.75) seems high if the signal is just "they switched from Basecamp to Asana." |
| `competitor_mention` | WEAK FIT | LOW — context of mention matters greatly | Weight (0.55) is reasonable for cases where it fires. |

**Overall verdict for Strategy A:** The 11 types are sufficient. No new signal types are required. The gaps are: (a) ICP relevance weight miscalibration, (b) no role-level filter on `job_posting`, (c) `news_events` and `technology_detections` PredictLeads modules not yet integrated.

### 4.2 For Strategy B (Commercial Roofing)

The 11 signal types are **fundamentally insufficient** for this ICP. The critical missing signal types:

| Missing Signal Type | Importance | Notes |
|---------------------|-----------|-------|
| `property_age` or `building_condition` | CRITICAL (highest buying intent signal) | Structural fact, not an event. Requires property data API. No mapping to current types. |
| `building_permit` | CRITICAL | Planning event. UK public data. No current provider. No mapping. |
| `weather_event` | CRITICAL (time-sensitive) | Storm damage demand. Weather API needed. New signal type required. |
| `regulatory_trigger` | HIGH | EPC compliance, planning mandates. UK regulatory data. No current provider. |
| `property_acquisition` | HIGH | M&A / change of ownership of physical property. CoStar / Land Registry. Partially via `expansion` but imprecise. |

**Overall verdict for Strategy B:** The current 11 signal types and the current provider (PredictLeads) are a poor architectural fit for commercial roofing. Implementing this ICP would require: new signal types, new provider integrations, and potentially a different data model (property-centric rather than company-centric).

---

## 5. ICP Recommendation for First Real Client Acquisition Experiment

### Recommendation: Strategy A (UK Creative/Marketing/Design Agencies)

**Rationale:**

#### 5.1 Signal Availability
Strategy A has two live signal types already flowing through the system (`job_posting` and `funding_round`). More importantly, `job_posting` — the single most commercially meaningful signal for this ICP — is operational today. The 198 ROCI companies have been ingested via Stage 30A. The foundation exists.

Strategy B requires entirely new providers (property databases, planning APIs, weather APIs) before a single meaningful signal can be detected. The gap is architectural, not operational.

#### 5.2 Signal Freshness
`job_posting` signals for UK agencies have a 14-day TTL, which aligns perfectly with the sales motion: a BD role posted today should be followed up within 72 hours. PredictLeads indexes job boards and company career pages with short refresh cycles. The signal-to-action lag is low.

For Strategy B, building age signals are evergreen but require a provider integration that doesn't exist. Storm damage signals need weather data that isn't in the current stack and would have a 7-day action window — very difficult to operationalize without real-time weather monitoring.

#### 5.3 Ability to Identify Genuine Buying Intent
Strategy A's highest-intent signal — a UK creative agency actively hiring a Head of New Business — is a **self-describing buying signal**. The prospect is literally advertising that they want what ROCI sells. This is the clearest possible signal of buying intent. It requires only a role-title filter on existing `job_posting` data, not new providers.

Strategy B's highest-intent signal (building age threshold) cannot be detected with any current component. The second-best signal (building permit) requires planning authority API integration across all UK local authorities (327 LPAs), which is a multi-month data engineering project.

#### 5.4 Contactability
UK creative agency founders and MDs have strong LinkedIn, email, and Apollo/Prospeo coverage. The Gramscode system already has an email enrichment waterfall (Stage 24) that works for this persona.

Commercial warehouse/logistics FM and property owners have more variable contact data quality. The buyer persona is also less consistent: property decisions can be made by an asset management firm, a pension fund, a developer, an FM company, or an owner-operator — all requiring different outreach angles.

#### 5.5 Potential Client ROI for ROCI
ROCI's value proposition (done-for-you outbound for agencies that are referral-dependent) is proven and specific. The ICP is precisely defined. The angle (agency hiring a BD person is the moment to intercept) is commercially testable in weeks.

Commercial roofing outbound requires a completely different motion: geographic targeting, physical property assessment, compliance-driven angles. The ROI story is less immediate and harder to instrument.

#### 5.6 Implementation Complexity
| Factor | Strategy A | Strategy B |
|--------|-----------|-----------|
| Provider gaps | Medium (news_events mapper) | Critical (3-4 new providers) |
| Signal type gaps | None | 3-5 new types needed |
| Schema changes | None | New tables likely (property-centric model) |
| Weight calibration | Needed but low-risk | Not applicable until providers exist |
| Time to first actionable signal | Signals already in DB | Months |
| Time to first send-ready account | Weeks (after rescore) | Quarters |

**Strategy A is the only ICP that can support a real client acquisition experiment in 2026. Strategy B is a future ICP requiring a fundamentally different provider stack.**

---

## 6. Proposed Stage 30C Implementation Plan

**Scope:** Still read-only on provider calls. No outbound. No Smartlead. Schema changes only if explicitly approved.

### Stage 30C.1 — Rescore (Requires Approval)
- Call `rescoreCompany()` for the 198 ROCI companies that received signals in Stage 30A
- Update `account_intelligence.opportunity_score` for companies with at least 1 active signal
- Capture BEFORE/AFTER deltas using the validation delta rule (never assert global zero-counts)
- Do NOT modify ICP weights — use existing weights as hypotheses
- Produce a post-rescore distribution: how many companies moved from score=0 to score>0?

### Stage 30C.2 — Role-Level Job Posting Classification
- Extend the PredictLeads job_opening mapper to classify role type from job title
- Classification: `bd_role` (Head of New Business, Business Development, Growth) vs. `delivery_role` (Designer, Developer, PM) vs. `other`
- Store classification in `signals.metadata` (no schema change)
- This makes the existing `job_posting` signal queryable by role type for personalization

### Stage 30C.3 — News Events Module Integration
- Write a `news_events` mapper for PredictLeads (parallel to the existing `job_openings` / `financing_events` mappers)
- Map PredictLeads news categories to existing signal types:
  - `acquisition` → `expansion`
  - `product_launch` → `product_launch`
  - `partnership` → `partnership`
  - `award` → `award` or `news_mention`
  - `expansion` → `expansion`
  - Other → `news_mention`
- Note: Executive hire via news_events needs validation — unclear if PredictLeads consistently indexes this category for UK SME agencies
- **No external API calls until approved**; implement mapper first, test with fake provider

### Stage 30C.4 — Priority Rescore and Top-20 Identification
- Run account prioritization (`rankAccountsForClient`) after the 30C.1 rescore
- Identify top 20 companies by `priority_score`
- For each: surface the active signals, flag BD-role job postings, surface the Why Now narrative if `is_ready = true`
- Output a human-readable priority brief (no mutations)

### Stage 30C.5 — ICP Relevance Weight Hypothesis Update (Requires Approval)
- Propose updated `ICP_RELEVANCE` weights for the creative agency ICP (see Section 1.3)
- **Do not change code until approved** — this is a design proposal only
- Once approved, update `opportunity-scoring.ts` and re-run `rescoreCompany()` for all 198 ROCI companies
- Compare score distribution BEFORE/AFTER weight change

### Stage 30C.6 — Coverage Audit
- Produce a signal coverage report: of the 198 ROCI companies, what % have at least 1 active signal?
- Break down by signal type
- Identify companies with 0 signals — are they there because PredictLeads has no coverage, or because no qualifying events occurred?
- This determines whether the 198-company list is large enough, or whether a broader initial list is needed

---

## 7. Key Open Questions Before Stage 30C

1. **What were the actual Stage 30A ingestion results?** How many of the 198 ROCI companies received at least 1 signal? What was the job_posting vs. funding_round split? This determines whether the scoring exercise is even meaningful at this scale. (Requires running the ingestion report or querying the DB directly.)

2. **What is PredictLeads' coverage rate for UK agencies with 5-50 staff?** If fewer than 30% of the 198 companies have any signal, the scoring exercise is premature. The list may need to grow or a supplementary provider may be needed.

3. **What ICP relevance weight approval process is needed?** Since weights are labelled `INITIAL_HYPOTHESIS_NOT_VALIDATED`, changing them requires explicit user approval before any code change.

4. **Is the `news_events` module included in the current PredictLeads subscription tier?** The codebase treats it as available but deferred. This should be confirmed with a single test API call against one domain before building the full mapper.

5. **Does ROCI have a preferred top-10 priority list from their own knowledge?** Having a human-curated "these are the 10 agencies we most want" list would provide a ground-truth check on whether the signal scoring surfaces the same companies.

---

## 8. Summary

| Dimension | Strategy A (UK Creative Agencies) | Strategy B (Commercial Roofing) |
|-----------|----------------------------------|--------------------------------|
| Signal availability now | HIGH (job_posting live) | NONE (providers don't exist) |
| Signal freshness | HIGH (14d TTL aligned with sales motion) | N/A until built |
| Genuine buying intent detectable? | YES (BD-role hiring is self-describing) | PARTIALLY (only FM hires detectable today) |
| Contactability | HIGH (LinkedIn/Apollo/Prospeo) | MODERATE (buyer persona inconsistent) |
| Implementation complexity | LOW-MEDIUM | VERY HIGH |
| Months to first send-ready account | 2-4 weeks | 3-6+ months |
| Recommended for first experiment | **YES** | NO |

**Stage 30B complete. Awaiting Stage 30C approval.**
