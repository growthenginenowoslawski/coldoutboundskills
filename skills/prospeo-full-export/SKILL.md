---
name: prospeo-full-export
description: Export your entire Prospeo people search to CSV. Build filters in Prospeo's UI, then use this skill to extract every result via the API — even searches over 25K. Handles pagination, rate limiting, deduplication, and state-by-state splitting automatically.
---

# Prospeo Full Search Export

Extract your entire Prospeo people search to a CSV file. Build your search in Prospeo's UI, then let Claude pull every single result via the API — even if the search has more than 25,000 results.

## What This Does

1. You build a search in Prospeo's web UI (filters for title, location, industry, company size, etc.)
2. You tell Claude what filters you used
3. Claude translates those filters into Prospeo API calls
4. Claude paginates through every page of results and exports to CSV
5. For large US searches (25K+), Claude automatically splits by state to get everything

## Setup (First Time Only)

### Step 1: Create a Prospeo Account

1. Go to [prospeo.io](https://prospeo.io) and sign up
2. Choose a plan that includes the **Search Person API** (most paid plans do)
3. Each API request that returns results costs **1 credit** and returns 25 contacts

### Step 2: Get Your API Key

1. Log into Prospeo
2. Go to **Settings > API** (or visit [prospeo.io/app/settings/api](https://prospeo.io/app/settings/api))
3. Copy your API key

### Step 3: Set Your API Key

Set it as an environment variable so Claude can use it:

```bash
# Add to your shell profile (~/.zshrc or ~/.bashrc)
export PROSPEO_API_KEY="your_api_key_here"
```

Then restart your terminal or run `source ~/.zshrc`.

**Security note:** Never paste your API key directly into a script file. Always use environment variables.

---

## How to Use

### Step 1: Build Your Search in Prospeo's UI

Go to [prospeo.io/app/search](https://prospeo.io/app/search) and use the filters to build your search. The UI lets you filter by:

- **Job title** (e.g., "CEO", "VP Sales", "Head of Marketing")
- **Location** (e.g., "United States", "California", "New York")
- **Company industry** (e.g., "Information Technology", "Healthcare")
- **Company headcount** (e.g., 11-500 employees)
- **Company technology** (e.g., "Salesforce", "HubSpot")
- **Revenue range**
- **Contact details** (has verified email, has phone number)

Note the total result count shown in the UI — you'll need this to estimate credits.

### Step 2: Tell Claude Your Filters

Just describe what you filtered for. Examples:

> "I searched for CEOs and CTOs at companies with 11-500 employees in the US, in the Information Technology industry, with verified emails."

> "I'm looking for VP of Sales and Head of Sales at SaaS companies in California with 50-200 employees."

> "I need all Marketing Directors in the US at companies using HubSpot, 20-1000 headcount."

### Step 3: Claude Runs the Export

Claude will:
1. Confirm the filters and estimated credit cost
2. Create a TypeScript script
3. Run it to paginate through all results
4. Export everything to a CSV file in your current directory

---

## Filter Reference

These are the exact filter names the Prospeo API accepts. When you describe your search, Claude maps your description to these:

| UI Filter | API Filter Key | Format |
|-----------|---------------|--------|
| Job Title | `person_job_title` | `{ include: ["CEO", "CTO"], exclude: ["Intern"] }` |
| Location | `person_location_search` | `{ include: ["California, United States #US"] }` |
| Industry | `company_industry` | `{ include: ["Information Technology"] }` |
| Headcount | `company_headcount_custom` | `{ min: 11, max: 500 }` |
| Technology | `company_technology` | `{ include: ["Salesforce", "HubSpot"] }` |
| Revenue | `company_revenue_custom` | `{ min: 1000000, max: 50000000 }` |
| Founded Year | `company_founding_year` | `{ min: 2010, max: 2025 }` |
| Company Name | `company_name` | `{ include: ["Acme"], exclude: ["Test"] }` |
| Company Domain | `company_domain` | `{ include: ["acme.com"] }` |
| Has Email | `person_contact_details` | `{ email: ["VERIFIED"] }` |
| Has Phone | `person_contact_details` | `{ mobile: ["TRUE"] }` |
| Exact Title Match | `person_job_title` | `{ include: [...], match_only_exact_job_titles: true }` |

### Location Format

Locations must follow this exact format:
- Country: `"United States #US"`, `"United Kingdom #GB"`, `"Canada #CA"`
- State: `"California, United States #US"`, `"Texas, United States #US"`
- City: `"San Francisco, California, United States #US"`

### Headcount Ranges (Common Presets)

| Label | min | max |
|-------|-----|-----|
| 1-10 | 1 | 10 |
| 11-50 | 11 | 50 |
| 51-200 | 51 | 200 |
| 201-500 | 201 | 500 |
| 501-1000 | 501 | 1000 |
| 1001-5000 | 1001 | 5000 |
| 5001-10000 | 5001 | 10000 |
| 10001+ | 10001 | (omit max) |

---

## API Details

**Endpoint:** `POST https://api.prospeo.io/search-person`

**Auth:** `X-KEY` header with your API key

**Rate Limit:** 2 requests per second (the script handles this automatically)

**Pagination:** 25 results per page, max 1000 pages = **25,000 results per search**

**Credits:** 1 credit per request that returns at least 1 result. A 25,000-result search costs ~1,000 credits.

### Request Format

```typescript
const response = await fetch('https://api.prospeo.io/search-person', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-KEY': process.env.PROSPEO_API_KEY!,
  },
  body: JSON.stringify({
    page: 1,  // 1-1000
    filters: {
      person_job_title: { include: ['CEO', 'CTO'] },
      person_location_search: { include: ['United States #US'] },
      company_headcount_custom: { min: 11, max: 500 },
      company_industry: { include: ['Information Technology'] },
      person_contact_details: { email: ['VERIFIED'] },
    },
  }),
});
```

### Response Format

```typescript
{
  error: false,
  results: [
    {
      person: {
        person_id: "abc123",
        first_name: "Jane",
        last_name: "Smith",
        full_name: "Jane Smith",
        current_job_title: "CEO",
        linkedin_url: "https://linkedin.com/in/janesmith",
        email: "jane@acme.com",
        email_status: "VERIFIED",
        phone: "+14155551234",
        location: { city: "San Francisco", state: "California", country: "United States" }
      },
      company: {
        name: "Acme Corp",
        domain: "acme.com",
        linkedin_url: "https://linkedin.com/company/acme",
        industry: "Information Technology",
        headcount: 150,
        headcount_range: "51-200",
        technologies: ["Salesforce", "HubSpot"],
        location: { city: "San Francisco", state: "California", country: "United States" }
      }
    }
  ],
  pagination: {
    current_page: 1,
    total_page: 400,
    total_count: 10000,
    per_page: 25
  }
}
```

---

## The 25K Limit: State-by-State Splitting

Prospeo caps any single search at 25,000 results (1,000 pages x 25 per page). If your US-wide search has more than 25K results, the script automatically splits it into 50 separate state-level searches.

**How it works:**
1. Run the search once to check `total_count`
2. If > 20,000, switch to state-by-state mode
3. Replace `"United States #US"` with each state (e.g., `"California, United States #US"`)
4. Paginate through each state's results
5. Deduplicate across states (by LinkedIn URL)

This means you can extract **hundreds of thousands** of results from a single search definition.

### US States (ordered by population for efficiency)

```
California, Texas, Florida, New York, Illinois, Pennsylvania,
Ohio, Georgia, North Carolina, Michigan, New Jersey, Virginia,
Washington, Arizona, Massachusetts, Tennessee, Indiana, Missouri,
Maryland, Wisconsin, Colorado, Minnesota, South Carolina, Alabama,
Louisiana, Kentucky, Oregon, Oklahoma, Connecticut, Utah, Iowa,
Nevada, Arkansas, Mississippi, Kansas, New Mexico, Nebraska,
Idaho, West Virginia, Hawaii, New Hampshire, Maine, Montana,
Rhode Island, Delaware, South Dakota, North Dakota, Alaska,
Vermont, Wyoming
```

---

## Script Template

When Claude generates the export script, it follows this pattern:

```typescript
import { writeFileSync } from 'fs';

// --- Config ---
const API_KEY = process.env.PROSPEO_API_KEY;
if (!API_KEY) {
  console.error('Set PROSPEO_API_KEY environment variable first.');
  process.exit(1);
}

const RATE_LIMIT_MS = 500; // 2 requests/sec
const MAX_RETRIES = 5;

// --- Types ---
interface ProspeoFilters {
  person_job_title?: { include?: string[]; exclude?: string[]; match_only_exact_job_titles?: boolean };
  person_location_search?: { include?: string[]; exclude?: string[] };
  company_headcount_custom?: { min?: number; max?: number };
  company_industry?: { include?: string[]; exclude?: string[] };
  company_technology?: { include?: string[]; exclude?: string[] };
  company_revenue_custom?: { min?: number; max?: number };
  company_founding_year?: { min?: number; max?: number };
  company_name?: { include?: string[]; exclude?: string[] };
  company_domain?: { include?: string[]; exclude?: string[] };
  person_contact_details?: { email?: string[]; mobile?: string[]; operator?: string };
}

// --- Rate-limited fetch ---
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function searchPage(filters: ProspeoFilters, page: number, retries = 0): Promise<any> {
  await sleep(RATE_LIMIT_MS);

  const res = await fetch('https://api.prospeo.io/search-person', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-KEY': API_KEY! },
    body: JSON.stringify({ page, filters }),
  });

  if (res.status === 429 && retries < MAX_RETRIES) {
    const backoff = Math.min(2000 * Math.pow(2, retries), 60000);
    console.log(`  Rate limited, waiting ${backoff / 1000}s...`);
    await sleep(backoff);
    return searchPage(filters, page, retries + 1);
  }

  if (!res.ok) throw new Error(`API error: ${res.status} ${res.statusText}`);
  return res.json();
}

// --- Deduplication ---
const seenLinkedIn = new Set<string>();
const seenEmail = new Set<string>();

function isDuplicate(person: any): boolean {
  const li = person.linkedin_url;
  const em = person.email;
  if (li && seenLinkedIn.has(li)) return true;
  if (em && seenEmail.has(em)) return true;
  if (li) seenLinkedIn.add(li);
  if (em) seenEmail.add(em);
  return false;
}

// --- CSV helpers ---
function escapeCSV(val: any): string {
  if (val == null) return '';
  const s = String(val);
  return s.includes(',') || s.includes('"') || s.includes('\n')
    ? `"${s.replace(/"/g, '""')}"` : s;
}

function resultToRow(r: any): string[] {
  const p = r.person || {};
  const c = r.company || {};
  return [
    p.first_name, p.last_name, p.full_name, p.current_job_title,
    p.email, p.email_status, p.phone, p.linkedin_url,
    p.location?.city, p.location?.state, p.location?.country,
    c.name, c.domain, c.linkedin_url, c.industry,
    c.headcount, c.headcount_range,
    (c.technologies || []).join('; '),
    c.location?.city, c.location?.state, c.location?.country,
  ];
}

const CSV_HEADERS = [
  'first_name', 'last_name', 'full_name', 'job_title',
  'email', 'email_status', 'phone', 'linkedin_url',
  'person_city', 'person_state', 'person_country',
  'company_name', 'company_domain', 'company_linkedin', 'company_industry',
  'company_headcount', 'company_headcount_range',
  'company_technologies',
  'company_city', 'company_state', 'company_country',
];

// --- Main export ---
async function exportSearch(filters: ProspeoFilters, outputFile: string, maxResults?: number) {
  console.log('Running initial search to check result count...');
  const first = await searchPage(filters, 1);

  if (first.error) {
    console.error('API error:', first.message);
    process.exit(1);
  }

  const totalCount = first.pagination?.total_count || 0;
  const totalPages = first.pagination?.total_page || 0;
  console.log(`Found ${totalCount.toLocaleString()} total results (${totalPages} pages)`);

  // Check if we need state-by-state splitting
  const needsSplit = totalCount > 20000
    && filters.person_location_search?.include?.some(l => l === 'United States #US');

  if (needsSplit) {
    console.log('Search exceeds 20K — switching to state-by-state mode...');
    await exportByState(filters, outputFile, maxResults);
    return;
  }

  // Simple pagination
  const rows: string[][] = [];
  const pagesToFetch = maxResults ? Math.min(Math.ceil(maxResults / 25), totalPages) : totalPages;
  const creditsEstimate = pagesToFetch;
  console.log(`Will fetch ${pagesToFetch} pages (~${creditsEstimate} credits)`);

  // Process page 1 results we already have
  for (const r of first.results || []) {
    if (!isDuplicate(r.person)) rows.push(resultToRow(r));
  }
  console.log(`  Page 1/${pagesToFetch} — ${rows.length} contacts`);

  for (let page = 2; page <= pagesToFetch; page++) {
    if (maxResults && rows.length >= maxResults) break;
    const data = await searchPage(filters, page);
    for (const r of data.results || []) {
      if (!isDuplicate(r.person)) rows.push(resultToRow(r));
    }
    if (page % 50 === 0 || page === pagesToFetch) {
      console.log(`  Page ${page}/${pagesToFetch} — ${rows.length} contacts so far`);
    }
  }

  writeCSV(outputFile, rows);
}

// --- State-by-state export ---
const US_STATES = [
  'California', 'Texas', 'Florida', 'New York', 'Illinois', 'Pennsylvania',
  'Ohio', 'Georgia', 'North Carolina', 'Michigan', 'New Jersey', 'Virginia',
  'Washington', 'Arizona', 'Massachusetts', 'Tennessee', 'Indiana', 'Missouri',
  'Maryland', 'Wisconsin', 'Colorado', 'Minnesota', 'South Carolina', 'Alabama',
  'Louisiana', 'Kentucky', 'Oregon', 'Oklahoma', 'Connecticut', 'Utah', 'Iowa',
  'Nevada', 'Arkansas', 'Mississippi', 'Kansas', 'New Mexico', 'Nebraska',
  'Idaho', 'West Virginia', 'Hawaii', 'New Hampshire', 'Maine', 'Montana',
  'Rhode Island', 'Delaware', 'South Dakota', 'North Dakota', 'Alaska',
  'Vermont', 'Wyoming',
];

async function exportByState(filters: ProspeoFilters, outputFile: string, maxResults?: number) {
  const rows: string[][] = [];

  for (let i = 0; i < US_STATES.length; i++) {
    if (maxResults && rows.length >= maxResults) break;

    const state = US_STATES[i];
    const stateFilters = JSON.parse(JSON.stringify(filters));
    stateFilters.person_location_search.include =
      stateFilters.person_location_search.include.map((loc: string) =>
        loc === 'United States #US' ? `${state}, United States #US` : loc
      );

    const first = await searchPage(stateFilters, 1);
    const stateTotal = first.pagination?.total_count || 0;
    const statePages = first.pagination?.total_page || 0;

    if (stateTotal === 0) {
      console.log(`  [${i + 1}/50] ${state}: 0 results, skipping`);
      continue;
    }

    // Process page 1
    for (const r of first.results || []) {
      if (!isDuplicate(r.person)) rows.push(resultToRow(r));
    }

    // Paginate remaining
    for (let page = 2; page <= statePages; page++) {
      if (maxResults && rows.length >= maxResults) break;
      const data = await searchPage(stateFilters, page);
      for (const r of data.results || []) {
        if (!isDuplicate(r.person)) rows.push(resultToRow(r));
      }
    }

    console.log(`  [${i + 1}/50] ${state}: ${stateTotal.toLocaleString()} results — ${rows.length.toLocaleString()} total contacts`);
  }

  writeCSV(outputFile, rows);
}

// --- Write CSV ---
function writeCSV(outputFile: string, rows: string[][]) {
  const lines = [CSV_HEADERS.join(',')];
  for (const row of rows) {
    lines.push(row.map(escapeCSV).join(','));
  }
  writeFileSync(outputFile, lines.join('\n'), 'utf-8');
  console.log(`\nExport complete!`);
  console.log(`  File: ${outputFile}`);
  console.log(`  Contacts: ${rows.length.toLocaleString()}`);
  console.log(`  Credits used: ~${seenLinkedIn.size + seenEmail.size > 0 ? 'see above' : rows.length / 25}`);
}

// --- Entry point ---
// Claude will fill in the filters based on your search description
const filters: ProspeoFilters = {
  // FILTERS_GO_HERE
};

const outputFile = 'prospeo-export.csv';
exportSearch(filters, outputFile);
```

---

## Credit Cost Estimation

Before running, Claude will estimate the credit cost:

| Total Results | Pages | Credits | Approximate Cost (varies by plan) |
|--------------|-------|---------|-----------------------------------|
| 1,000 | 40 | 40 | ~$2 |
| 5,000 | 200 | 200 | ~$10 |
| 25,000 | 1,000 | 1,000 | ~$50 |
| 100,000 (state split) | ~4,000 | ~4,000 | ~$200 |

Claude will always tell you the estimated cost and ask for confirmation before running the full export.

---

## Example Conversations

**Simple search:**
> "Export all CEOs at 11-50 person companies in California in the SaaS industry with verified emails."

**Large US-wide search:**
> "I need every VP of Sales and Head of Sales in the US at companies with 50-500 employees. The Prospeo UI shows 87,000 results."

**With exclusions:**
> "Marketing Directors in the US, exclude staffing and recruiting industries, 20-200 headcount, must have verified email."

**With technology filter:**
> "CTOs at companies using Shopify in the US, any company size."

---

## Troubleshooting

### "Set PROSPEO_API_KEY environment variable first"
Your API key isn't set. Run: `export PROSPEO_API_KEY="your_key"` in your terminal.

### "API error: 401"
Your API key is invalid. Check it at [prospeo.io/app/settings/api](https://prospeo.io/app/settings/api).

### "API error: 402"
You're out of credits. Top up your Prospeo account.

### "API error: 429"
Rate limited. The script handles this automatically with exponential backoff. If it persists, you're making too many concurrent requests — only run one export at a time.

### Results seem low
- Check that your location format is correct (must include `#US`, `#GB`, etc.)
- Broaden your title filters — Prospeo does fuzzy matching by default
- Remove the `person_contact_details` filter to see all results (not just those with verified emails)

### Duplicates across states
The script deduplicates by LinkedIn URL automatically. Some contacts may appear in multiple state searches if they've relocated — the dedup handles this.

---

## Requirements

- **Node.js 18+** (for native `fetch` support)
- **TypeScript** (`npm install -g tsx` to run .ts files directly)
- A Prospeo account with API credits

No other dependencies needed — the script uses only built-in Node.js modules.
