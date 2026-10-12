# LIST_MEMBERS

## 1. What is this table?

`list_members` is a junction table — it connects lists to both companies and contacts. Instead of putting all the companies directly inside the `lists` table, there's a separate row in `list_members` for every (list, company) pair and every (list, contact) pair.

This design lets one company appear in multiple lists, and one list contain hundreds of companies, without any data duplication.

## 2. Why does this table exist?

Many-to-many relationships in databases require a junction table. A company can be in many lists (you might source Apple in a "tech CEOs" run AND a "SF enterprise" run). A list can contain many companies. The junction table handles this cleanly. It's also how the system tracks which company belongs to which list for the qualification pipeline.

## 3. What data does it store?

| Column | Type | What it means |
|--------|------|---------------|
| `id` | uuid | Unique identifier for this membership row |
| `list_id` | uuid | Which list this membership belongs to (→ lists.id) |
| `company_id` | uuid | Which company is in this list (→ companies.id) — nullable |
| `contact_id` | uuid | Which contact is in this list (→ contacts.id) — nullable |
| `created_at` | timestamptz | When this membership was created |

Either `company_id` or `contact_id` will be populated, but not necessarily both. Some lists are company lists (list-builder style); others are contact lists (Prospeo pull style).

## 4. Primary Key

`id` — UUID, auto-generated.

## 5. Foreign Keys

- `list_id → lists(id)` — which list
- `company_id → companies(id)` — which company (nullable)
- `contact_id → contacts(id)` — which contact (nullable)

## 6. What comes before it?

Both the list and the company (or contact) must exist before a `list_members` row can be created.

## 7. What comes after it?

No tables point to `list_members`. It's a leaf junction node. But it enables:
- `qualify-list.ts` — reads list_members to find companies to qualify
- `show-contacts.ts` — reads list_members to find contacts in a list

## 8. Who writes to this table?

- **`storeCompaniesInList()` in `src/db/companies.ts`** — called by list-builder skills; inserts one row per company
- **`prospeo-pull.ts` `linkContactToList()`** — inserts one row per contact after Prospeo pull

## 9. Who reads from this table?

- **`qualify-list.ts`** — joins list_members to companies to get all companies in a list for AI qualification
- **`show-contacts.ts`** — queries list_members to find contacts when the direct `list_id` path doesn't work

## 10. Real example

After running prospeo-pull for the ROCI ICP list:
```
List: "ROCI ICP - UK Agency Founders Aug 2026" (id: aaa-bbb-ccc)
Company: "Social Chain" (id: ddd-eee-fff)

list_members row:
  id:         (uuid)
  list_id:    aaa-bbb-ccc
  company_id: ddd-eee-fff
  contact_id: NULL
  created_at: 2026-08-14T18:05:00Z
```

And separately for a contact in the same list:
```
  list_id:    aaa-bbb-ccc
  company_id: NULL
  contact_id: (contact uuid)
```

## 11. How this table participates in a campaign

`list_members` is the bridge between "I have a list of targets" and "I'm qualifying/enriching those targets." When `qualify-list.ts` runs, it reads:

```
list_members WHERE list_id = ?
  JOIN companies ON company_id
```

to get every company in the list. Each company then goes through AI qualification (written to `enrichment_runs`), and the company's `icp_score` is updated.

## 12. Simple mental model

"list_members = the roster of who's in each list; one row per (list, company) or (list, contact) pair."

## 13. SQL to inspect it

```sql
-- All companies in a specific list
SELECT c.name, c.domain, c.status, c.icp_score
FROM list_members lm
JOIN companies c ON c.id = lm.company_id
WHERE lm.list_id = 'your-list-id-here'
  AND lm.company_id IS NOT NULL
ORDER BY c.name;

-- All contacts in a list (via junction)
SELECT c.full_name, c.job_title, c.email
FROM list_members lm
JOIN contacts c ON c.id = lm.contact_id
WHERE lm.list_id = 'your-list-id-here'
  AND lm.contact_id IS NOT NULL
ORDER BY c.full_name;

-- Which lists does a specific company appear in?
SELECT l.name, l.created_at
FROM list_members lm
JOIN lists l ON l.id = lm.list_id
WHERE lm.company_id = 'cac84e2a-caf5-4248-9190-17227de64af8'  -- Stripe
ORDER BY l.created_at;

-- Size of each list
SELECT l.name, COUNT(*) AS member_count
FROM lists l
LEFT JOIN list_members lm ON lm.list_id = l.id
GROUP BY l.id, l.name
ORDER BY member_count DESC;
```
