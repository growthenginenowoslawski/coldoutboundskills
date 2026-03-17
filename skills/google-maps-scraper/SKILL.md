---
name: google-maps-scraper
description: Set up and run a Google Maps business scraper using the RapidAPI Maps Data API. Searches by query + location, returns structured business data (name, address, phone, website, rating, reviews, coordinates). Works as a local CLI or can be deployed as a web app. Use when someone wants to scrape Google Maps for business listings.
---

# Google Maps Scraper

A self-contained tool for scraping business listings from Google Maps. Give it a search query (e.g., "pizza restaurant") and a location (zip code, city, or coordinates), and it returns structured data for every matching business.

## What You Need Before Starting

1. **Node.js 18+** and **npm** installed
2. **A RapidAPI account** (free tier available) with a subscription to the **Maps Data API**:
   - Sign up at https://rapidapi.com
   - Subscribe to the API: https://rapidapi.com/alexanderxbx/api/maps-data
   - Copy your RapidAPI key from the dashboard (it's in the `X-RapidAPI-Key` header on any endpoint page)

That's it. No Google Cloud account, no OAuth, no billing setup beyond RapidAPI.

## Project Setup

Create a new project directory and initialize it:

```bash
mkdir google-maps-scraper && cd google-maps-scraper
npm init -y
npm install typescript bottleneck
npm install -D @types/node tsx
```

Add to `package.json` scripts:
```json
{
  "scripts": {
    "scrape": "tsx src/index.ts"
  }
}
```

Create `tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "esModuleInterop": true,
    "strict": true,
    "outDir": "dist",
    "rootDir": "src",
    "skipLibCheck": true
  },
  "include": ["src"]
}
```

Set your API key as an environment variable:
```bash
export RAPIDAPI_KEY=your_key_here
```

Or create a `.env` file (add `.env` to `.gitignore`):
```
RAPIDAPI_KEY=your_key_here
```

## File Structure

```
google-maps-scraper/
  data/
    us-zip-codes.csv   # 42,734 US zip codes with city, state, lat/lng, population
  src/
    index.ts           # CLI entry point
    client.ts          # RapidAPI Maps Data client with rate limiting
    types.ts           # TypeScript interfaces
    csv.ts             # CSV export
    zips.ts            # Zip code loader (filter by state, city, population)
```

## Bundled Zip Code Database

The repo includes `data/us-zip-codes.csv` — a complete US zip code reference with 42,734 entries. Columns:

```
zip,primary_city,state,timezone,area_codes,world_region,country,latitude,longitude,irs_estimated_population
```

This lets you scrape an entire state or metro area without manually listing zip codes. The `src/zips.ts` loader provides filtering by state, city, and minimum population.

## Core Files

### src/types.ts

```typescript
export interface SearchParams {
  query: string;       // "pizza restaurant", "dentist", "gym"
  lat?: number;        // Center latitude (optional if using "query in zipcode" format)
  lng?: number;        // Center longitude
  limit?: number;      // Max results per search (default 20, max 20)
  zoom?: number;       // Map zoom level (default 13 = neighborhood)
  country?: string;    // Country code (default "us")
}

export interface Place {
  place_id: string;
  name: string;
  address: string;
  lat: number;
  lng: number;
  rating?: number;
  reviews_count?: number;
  phone?: string;
  website?: string;
  types?: string[];
  category?: string;
}

export interface ScrapeResult {
  query: string;
  location: string;
  total_results: number;
  unique_results: number;
  places: Place[];
  duration_ms: number;
}
```

### src/zips.ts

Loads and filters the bundled zip code CSV. Lets you target by state, city name, or minimum population.

```typescript
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

export interface ZipEntry {
  zip: string;
  city: string;
  state: string;
  lat: number;
  lng: number;
  population: number;
}

let cache: ZipEntry[] | null = null;

function loadAll(): ZipEntry[] {
  if (cache) return cache;
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const csvPath = join(__dirname, '..', 'data', 'us-zip-codes.csv');
  const raw = readFileSync(csvPath, 'utf-8');
  const lines = raw.trim().split('\n').slice(1); // skip header

  cache = lines.map(line => {
    // Handle quoted fields (area_codes can contain commas)
    const parts: string[] = [];
    let current = '';
    let inQuotes = false;
    for (const ch of line) {
      if (ch === '"') { inQuotes = !inQuotes; continue; }
      if (ch === ',' && !inQuotes) { parts.push(current); current = ''; continue; }
      current += ch;
    }
    parts.push(current);

    return {
      zip: parts[0]?.padStart(5, '0') || '',
      city: parts[1] || '',
      state: parts[2] || '',
      lat: parseFloat(parts[7]) || 0,
      lng: parseFloat(parts[8]) || 0,
      population: parseInt(parts[9]) || 0,
    };
  }).filter(z => z.zip.length === 5);

  return cache;
}

/** Get zips for a US state (2-letter code, e.g. "CA", "TX") */
export function getZipsByState(stateCode: string): ZipEntry[] {
  return loadAll().filter(z => z.state.toUpperCase() === stateCode.toUpperCase());
}

/** Get zips for a city name (case-insensitive, partial match) */
export function getZipsByCity(city: string, state?: string): ZipEntry[] {
  const cityLower = city.toLowerCase();
  return loadAll().filter(z => {
    const cityMatch = z.city.toLowerCase().includes(cityLower);
    const stateMatch = !state || z.state.toUpperCase() === state.toUpperCase();
    return cityMatch && stateMatch;
  });
}

/** Get zips with population above a threshold */
export function getZipsByMinPopulation(minPop: number, state?: string): ZipEntry[] {
  return loadAll().filter(z => {
    const popMatch = z.population >= minPop;
    const stateMatch = !state || z.state.toUpperCase() === state.toUpperCase();
    return popMatch && stateMatch;
  });
}

/** Get all loaded zip entries */
export function getAllZips(): ZipEntry[] {
  return loadAll();
}
```

### src/client.ts

This is the core API client. It handles rate limiting (2 req/sec) and retries with exponential backoff.

```typescript
import Bottleneck from 'bottleneck';
import type { SearchParams, Place } from './types.js';

interface RawSearchResponse {
  data?: Array<{
    place_id?: string;
    title?: string;
    name?: string;
    address?: string;
    latitude?: number;
    longitude?: number;
    rating?: number;
    reviews?: number;
    phone?: string;
    website?: string;
    types?: string[];
    type?: string;
    category?: string;
  }>;
  error?: string;
}

interface GeocodingResponse {
  latitude?: number;
  longitude?: number;
  formatted_address?: string;
  error?: string;
}

export class GoogleMapsClient {
  private limiter: Bottleneck;
  private apiKey: string;
  private host = 'maps-data.p.rapidapi.com';
  private maxRetries: number;

  constructor(opts: { apiKey: string; requestsPerSecond?: number; maxRetries?: number }) {
    this.apiKey = opts.apiKey;
    this.maxRetries = opts.maxRetries ?? 3;
    this.limiter = new Bottleneck({
      maxConcurrent: 1,
      minTime: Math.floor(1000 / (opts.requestsPerSecond ?? 2)),
    });
  }

  /** Search Google Maps for businesses */
  async search(params: SearchParams): Promise<Place[]> {
    const response = await this.request<RawSearchResponse>('searchmaps.php', {
      query: params.query,
      limit: String(params.limit ?? 20),
      country: params.country ?? 'us',
      ...(params.lat != null && { lat: String(params.lat) }),
      ...(params.lng != null && { lng: String(params.lng) }),
      ...(params.zoom != null && { zoom: String(params.zoom) }),
    });

    if (response.error) throw new Error(`Search failed: ${response.error}`);
    return this.transform(response.data || []);
  }

  /** Geocode a zip code or address to lat/lng */
  async geocode(query: string, country = 'us'): Promise<{ lat: number; lng: number }> {
    const response = await this.request<GeocodingResponse>('geocoding.php', {
      query: `${query}, ${country.toUpperCase()}`,
    });
    if (!response.latitude || !response.longitude) {
      throw new Error(`Could not geocode: ${query}`);
    }
    return { lat: response.latitude, lng: response.longitude };
  }

  private async request<T>(endpoint: string, params: Record<string, string>): Promise<T> {
    return this.limiter.schedule(() => this.requestWithRetry<T>(endpoint, params));
  }

  private async requestWithRetry<T>(
    endpoint: string,
    params: Record<string, string>,
    attempt = 0
  ): Promise<T> {
    const url = new URL(`https://${this.host}/${endpoint}`);
    for (const [k, v] of Object.entries(params)) {
      if (v != null) url.searchParams.set(k, v);
    }

    try {
      const res = await fetch(url.toString(), {
        headers: {
          'X-RapidAPI-Key': this.apiKey,
          'X-RapidAPI-Host': this.host,
        },
      });

      if (!res.ok) {
        const err: any = new Error(`API ${res.status}: ${res.statusText}`);
        err.statusCode = res.status;
        throw err;
      }

      return (await res.json()) as T;
    } catch (err: any) {
      const retryable =
        attempt < this.maxRetries &&
        (err.statusCode === 429 || err.statusCode >= 500 ||
         err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT');

      if (retryable) {
        const delay = 1000 * Math.pow(2, attempt);
        console.log(`  Retry ${attempt + 1}/${this.maxRetries} in ${delay}ms...`);
        await new Promise(r => setTimeout(r, delay));
        return this.requestWithRetry<T>(endpoint, params, attempt + 1);
      }
      throw err;
    }
  }

  private transform(data: NonNullable<RawSearchResponse['data']>): Place[] {
    return data.map(item => ({
      place_id: item.place_id || '',
      name: item.title || item.name || '',
      address: item.address || '',
      lat: item.latitude || 0,
      lng: item.longitude || 0,
      rating: item.rating,
      reviews_count: item.reviews,
      phone: item.phone,
      website: item.website,
      types: item.types || (item.type ? [item.type] : []),
      category: item.category || item.type,
    }));
  }
}
```

### src/csv.ts

```typescript
import { writeFile, mkdir } from 'fs/promises';
import { dirname } from 'path';
import type { Place } from './types.js';

const HEADERS = [
  'place_id', 'name', 'address', 'phone', 'website',
  'rating', 'reviews_count', 'lat', 'lng', 'category',
];

function escape(val: string | number | undefined | null): string {
  if (val == null) return '';
  const s = String(val);
  return s.includes(',') || s.includes('"') || s.includes('\n')
    ? `"${s.replace(/"/g, '""')}"`
    : s;
}

export async function exportCSV(places: Place[], outputPath: string): Promise<void> {
  await mkdir(dirname(outputPath), { recursive: true });
  const lines = [
    HEADERS.join(','),
    ...places.map(p =>
      HEADERS.map(h => escape(p[h as keyof Place])).join(',')
    ),
  ];
  await writeFile(outputPath, lines.join('\n') + '\n', 'utf-8');
}
```

### src/index.ts

```typescript
import { GoogleMapsClient } from './client.js';
import { exportCSV } from './csv.js';
import { getZipsByState, getZipsByCity, getZipsByMinPopulation } from './zips.js';
import type { Place } from './types.js';

function dedup(places: Place[]): Place[] {
  const seen = new Set<string>();
  return places.filter(p => {
    if (seen.has(p.place_id)) return false;
    seen.add(p.place_id);
    return true;
  });
}

function getArg(args: string[], prefix: string): string | undefined {
  const match = args.find(a => a.startsWith(prefix));
  return match ? match.split('=').slice(1).join('=') : undefined;
}

async function main() {
  const args = process.argv.slice(2);

  const query = getArg(args, '--query=');
  const zips = getArg(args, '--zips=');
  const cities = getArg(args, '--cities=');
  const state = getArg(args, '--state=');
  const minPop = getArg(args, '--min-pop=');
  const limit = parseInt(getArg(args, '--limit=') || '20', 10);
  const output = getArg(args, '--output=') || './output/results.csv';

  if (!query || (!zips && !cities && !state)) {
    console.log(`
Google Maps Scraper

USAGE:
  npm run scrape -- --query="pizza restaurant" --zips=10014,10013,10012
  npm run scrape -- --query="dentist" --state=TX
  npm run scrape -- --query="dentist" --state=TX --min-pop=10000
  npm run scrape -- --query="gym" --cities="Austin TX,Dallas TX"

OPTIONS:
  --query=QUERY      Business type to search for (required)
  --zips=ZIP,ZIP     Comma-separated zip codes to search
  --cities=CITY,CITY Comma-separated cities to search
  --state=XX         Search all zip codes in a US state (2-letter code)
  --min-pop=N        Filter zips to those with population >= N (use with --state)
  --limit=N          Max results per location (default 20, max 20)
  --output=PATH      Output CSV path (default ./output/results.csv)

ENVIRONMENT:
  RAPIDAPI_KEY       Your RapidAPI key (required)
                     Get one at: https://rapidapi.com/alexanderxbx/api/maps-data

EXAMPLES:
  # All pizza places in California (zips with pop >= 5000)
  npm run scrape -- --query="pizza restaurant" --state=CA --min-pop=5000

  # Dentists in specific NYC zip codes
  npm run scrape -- --query="dentist" --zips=10014,10013,10012

  # Gyms across Texas cities
  npm run scrape -- --query="gym" --cities="Austin TX,Dallas TX,Houston TX"
`);
    process.exit(1);
  }

  const apiKey = process.env.RAPIDAPI_KEY;
  if (!apiKey) {
    console.error('Error: RAPIDAPI_KEY environment variable is required');
    console.error('Get your key at: https://rapidapi.com/alexanderxbx/api/maps-data');
    process.exit(1);
  }

  // Build location list from all sources
  const locations: string[] = [];

  if (zips) {
    locations.push(...zips.split(',').map(s => s.trim()));
  }
  if (cities) {
    locations.push(...cities.split(',').map(s => s.trim()));
  }
  if (state) {
    const minPopNum = minPop ? parseInt(minPop, 10) : 0;
    const stateZips = minPopNum > 0
      ? getZipsByMinPopulation(minPopNum, state)
      : getZipsByState(state);
    locations.push(...stateZips.map(z => z.zip));
    console.log(`Loaded ${stateZips.length} zip codes for ${state.toUpperCase()}${minPopNum > 0 ? ` (pop >= ${minPopNum.toLocaleString()})` : ''}`);
  }

  if (locations.length === 0) {
    console.error('No locations to search. Provide --zips, --cities, or --state.');
    process.exit(1);
  }

  console.log(`Scraping "${query}" across ${locations.length} location(s)...\n`);

  const client = new GoogleMapsClient({ apiKey, requestsPerSecond: 2 });
  const allPlaces: Place[] = [];
  const start = Date.now();

  for (let i = 0; i < locations.length; i++) {
    const loc = locations[i];
    console.log(`  [${i + 1}/${locations.length}] Searching: ${query} in ${loc}`);

    try {
      const results = await client.search({
        query: `${query} in ${loc}`,
        limit,
        country: 'us',
      });
      allPlaces.push(...results);
      console.log(`    Found ${results.length} results`);
    } catch (err: any) {
      console.error(`    Error: ${err.message}`);
    }
  }

  // Deduplicate
  const unique = dedup(allPlaces);
  console.log(`\nTotal: ${allPlaces.length} results, ${unique.length} unique after dedup`);

  // Export
  await exportCSV(unique, output);
  console.log(`Saved to: ${output}`);

  const duration = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`Done in ${duration}s`);

  // Print sample
  if (unique.length > 0) {
    console.log('\nSample result:');
    const sample = unique[0];
    console.log(`  ${sample.name}`);
    console.log(`  ${sample.address}`);
    if (sample.phone) console.log(`  ${sample.phone}`);
    if (sample.website) console.log(`  ${sample.website}`);
    if (sample.rating) console.log(`  ${sample.rating} stars (${sample.reviews_count} reviews)`);
  }
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
```

## Running It

### Local CLI

```bash
# Search pizza places in 3 NYC zip codes
npm run scrape -- --query="pizza restaurant" --zips=10014,10013,10012

# Search ALL dentists in Texas (zips with population >= 5000)
npm run scrape -- --query="dentist" --state=TX --min-pop=5000

# Every gym in California (all 2,657 zip codes — takes a while)
npm run scrape -- --query="gym" --state=CA

# Search dentists across specific cities
npm run scrape -- --query="dentist" --cities="Austin TX,Dallas TX,San Antonio TX"

# Custom output file
npm run scrape -- --query="gym" --zips=90210 --output=./data/gyms.csv
```

### Programmatic Usage

```typescript
import { GoogleMapsClient } from './client.js';

const client = new GoogleMapsClient({
  apiKey: process.env.RAPIDAPI_KEY!,
  requestsPerSecond: 2,
});

// Simple search
const places = await client.search({
  query: 'coffee shop in 94105',
  limit: 20,
});

// Search with coordinates
const { lat, lng } = await client.geocode('94105');
const nearby = await client.search({
  query: 'coffee shop',
  lat,
  lng,
  zoom: 14,
  limit: 20,
});
```

## Deploying as a Web App (Optional)

If you want a browser UI instead of (or in addition to) the CLI, add Express:

```bash
npm install express
npm install -D @types/express
```

Create `src/server.ts`:

```typescript
import express from 'express';
import { GoogleMapsClient } from './client.js';
import { exportCSV } from './csv.js';
import { tmpdir } from 'os';
import { join } from 'path';
import { readFile, unlink } from 'fs/promises';

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const client = new GoogleMapsClient({
  apiKey: process.env.RAPIDAPI_KEY!,
  requestsPerSecond: 2,
});

// Simple HTML form
app.get('/', (_req, res) => {
  res.send(`<!DOCTYPE html>
<html><head><title>Google Maps Scraper</title></head>
<body style="font-family:sans-serif;max-width:600px;margin:40px auto;padding:0 20px">
  <h1>Google Maps Scraper</h1>
  <form method="POST" action="/scrape">
    <label>Search query:<br>
      <input name="query" placeholder="pizza restaurant" style="width:100%;padding:8px;margin:4px 0 12px" required>
    </label>
    <label>Locations (comma-separated zips or cities):<br>
      <input name="locations" placeholder="10014, 10013, 10012" style="width:100%;padding:8px;margin:4px 0 12px" required>
    </label>
    <button type="submit" style="padding:10px 24px;cursor:pointer">Scrape</button>
  </form>
</body></html>`);
});

app.post('/scrape', async (req, res) => {
  const { query, locations: locStr } = req.body;
  const locations = locStr.split(',').map((s: string) => s.trim()).filter(Boolean);

  const allPlaces: any[] = [];
  for (const loc of locations) {
    try {
      const results = await client.search({ query: `${query} in ${loc}`, limit: 20 });
      allPlaces.push(...results);
    } catch {}
  }

  // Dedup
  const seen = new Set<string>();
  const unique = allPlaces.filter(p => { if (seen.has(p.place_id)) return false; seen.add(p.place_id); return true; });

  // Export CSV and send as download
  const tmpPath = join(tmpdir(), `scrape-${Date.now()}.csv`);
  await exportCSV(unique, tmpPath);
  const csv = await readFile(tmpPath, 'utf-8');
  await unlink(tmpPath);

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="maps-scrape-${Date.now()}.csv"`);
  res.send(csv);
});

const port = parseInt(process.env.PORT || '3000', 10);
app.listen(port, () => console.log(`Scraper running at http://localhost:${port}`));
```

Add a script to `package.json`:
```json
{
  "scripts": {
    "scrape": "tsx src/index.ts",
    "serve": "tsx src/server.ts"
  }
}
```

Run locally: `npm run serve` then open http://localhost:3000

### Deploying to Railway

1. Push your project to a GitHub repo
2. Go to https://railway.com, create a new project, connect the repo
3. Set the environment variable `RAPIDAPI_KEY` in Railway's dashboard
4. Set the start command to `npx tsx src/server.ts`
5. Railway auto-detects the port from `process.env.PORT` and gives you a public URL

You can add password protection by checking a `PASSWORD` env var in the POST handler, or use Railway's built-in auth features.

### Deploying to Other Platforms

This is a standard Node.js app. It runs anywhere:
- **Render**: Connect GitHub repo, set env vars, done
- **Fly.io**: `fly launch`, set secrets with `fly secrets set RAPIDAPI_KEY=xxx`
- **Vercel**: Deploy as a serverless function (modify server.ts to export handlers)
- **Docker**: `FROM node:20-slim` + `npm install` + `npx tsx src/server.ts`

## API Reference

The underlying API is the **Maps Data API** on RapidAPI:
https://rapidapi.com/alexanderxbx/api/maps-data

### Key Endpoints Used

| Endpoint | Purpose | Example |
|---|---|---|
| `searchmaps.php` | Search businesses by query + location | `?query=pizza+in+10014&limit=20` |
| `geocoding.php` | Convert address/zip to lat/lng | `?query=10014,+US` |
| `nearby.php` | Search near a lat/lng point | `?query=pizza&lat=40.73&lng=-74.00` |
| `place.php` | Get full details for one business | `?place_id=ChIJ...` |

### Rate Limits

The free tier on RapidAPI has request limits (check your plan). The client is hard-coded to 2 requests/second with automatic retries on 429s. Adjust `requestsPerSecond` if your plan allows more.

### Response Fields

Each result includes:
- `place_id` — unique Google Maps identifier
- `name` — business name
- `address` — full street address
- `phone` — phone number (if listed)
- `website` — website URL (if listed)
- `rating` — star rating (1-5)
- `reviews_count` — number of Google reviews
- `lat` / `lng` — coordinates
- `types` / `category` — business categories (e.g., "pizza_restaurant")

## Tips

- **"query in zipcode"** format works best for US searches. No coordinates needed.
- **20 results per search** is the max. To get more coverage, search multiple overlapping zip codes.
- **Dedup by `place_id`** — the same business often shows up in adjacent zip code searches.
- **Cuisine/category filtering**: The `types` field tells you what kind of business it is. Use it to filter out irrelevant results (e.g., filter out "bar" when searching for "restaurant").
- **Cost**: Check your RapidAPI plan. The free tier usually gives you enough for testing. Paid plans are cheap for bulk scraping.
