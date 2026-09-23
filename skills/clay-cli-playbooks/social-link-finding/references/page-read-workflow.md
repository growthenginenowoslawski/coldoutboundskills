# Reading the company's own page for social links

Two ways to read a homepage on Clay, and they differ in price and in what they return. Pick one at the
Step 5 gate; never mix them inside one run.

| Arm | Action | Cost (read live 2026-09-23) | What it returns | Run in this build |
|---|---|---|---|---|
| Clay page scraper | `scrape-website`, Clay utility package, `outputFields` including `socialLinks` and `links` | 1 credit per page | extracted social links and all anchors | no (the workspace had 1.5 credits) |
| Bring-your-own page reader | `apify-run-actor` with the public `apify/rag-web-browser` actor, markdown output | 0 Clay credits; the reader's own account bills per page | the page as markdown, links inline | yes, 12 runs on 6 domains |

The free HTTP action is **not** a third option: it returned an empty body for every HTML page probed
on 2026-09-23 (it keeps JSON bodies only), so it cannot see a link.

## The one setting that decides whether the reader finds anything

The page reader's defaults strip navigation and footer elements to produce "readable content". Social
icons live in the footer. Measured on the same five food-and-drink homepages:

| Setting | Rows with at least one social link found | LinkedIn found |
|---|---|---|
| default removal selector | 3 of 5 (two rows returned pages of 3.5 KB and 95 KB with zero social links) | 0 of 5 |
| `removeElementsCssSelector: "noscript"` (keep everything else) | 5 of 5 | 5 of 5 |

A 95 KB page with zero links reads exactly like a company with no socials. That is why
`scripts/build_page_read_node.py` sets the selector explicitly, and why Step 3 of the skill checks the
setting before the batch.

## Workflow shape

Linear: trigger (`domain`), `Build` (code, `scripts/build_page_read_node.py`), `Page read` (tool),
`Extract` (code, `scripts/extract_socials_node.py`).

```
clay workflows create --name "social-link-finding page read (safe to delete)"            # -> WF
clay workflows triggers create WF --input '{"triggerType":"manual","inputSchema":{"type":"object","properties":{"domain":{"type":"string"}},"required":["domain"]}}'
clay workflows graph get WF --mode summary | jq .summary.nodes                             # -> T
clay workflows nodes create WF --input build.json      # -> B
clay workflows nodes create WF --input page.json       # -> P
clay workflows nodes create WF --input extract.json    # -> E
clay workflows runs test WF --inputs '{"domain":"northwind-example.com"}'
clay workflows runs steps WF RUN      # .data[-1].stepOutputs holds the six platform fields
```

`build.json`:

```json
{"nodeType":"code","name":"Build","incomingEdges":[{"sourceNode":"T"}],
 "code":"<contents of scripts/build_page_read_node.py>",
 "inputSchema":{"type":"object","required":["domain"],"properties":{
   "domain":{"type":"string","sourceNodeId":"T","sourcePath":"$.domain"}}},
 "outputSchema":{"clean":{"type":"string","description":"bare domain"},
   "input_ok":{"type":"string","description":"yes or no"},
   "actor_input":{"type":"string","description":"page reader input JSON"}}}
```

`page.json`:

```json
{"nodeType":"tool","name":"Page read","incomingEdges":[{"sourceNode":"B"}],
 "tools":[{"toolType":"clay_action","actionKey":"apify-run-actor","actionPackageId":"<package id read in Step 0>",
  "inputMappingConfig":{
   "actorId":{"type":"static","value":"apify/rag-web-browser"},
   "data":{"type":"reference","expression":"{{actor_input}}"},
   "limit":{"type":"static","value":"1"}}}],
 "inputSchema":{"type":"object","required":["actor_input"],"properties":{
   "actor_input":{"type":"string","sourceNodeId":"B","sourcePath":"$.actor_input"}}}}
```

`extract.json`:

```json
{"nodeType":"code","name":"Extract","incomingEdges":[{"sourceNode":"P"}],
 "code":"<contents of scripts/extract_socials_node.py>",
 "inputSchema":{"type":"object","properties":{
   "page":{"type":"object","sourceNodeId":"P","sourcePath":"$.result"}}},
 "outputSchema":{"page_status":{"type":"string","description":"read|thin|blocked|unreadable"},
   "http_status":{"type":"string","description":"status the reader saw"},
   "bytes":{"type":"number","description":"markdown length"},
   "candidates_seen":{"type":"string","description":"distinct candidates per platform, JSON"},
   "linkedin":{"type":"string","description":"canonical URL or empty"},
   "x":{"type":"string","description":"canonical URL or empty"},
   "facebook":{"type":"string","description":"canonical URL or empty"},
   "instagram":{"type":"string","description":"canonical URL or empty"},
   "youtube":{"type":"string","description":"canonical URL or empty"},
   "tiktok":{"type":"string","description":"canonical URL or empty"}}}
```

A nonexistent domain came back from the reader with `httpStatusCode: 500` and an empty page, which the
Extract node reports as `unreadable`. The reader's output ran to 680 KB on one storefront with no
truncation observed.

## If the installer chose the Clay page scraper instead

Replace the `Page read` tool with `scrape-website` (`url` = `https://` plus the domain,
`outputFields` = `socialLinks, links`), and point `Extract` at the concatenated link hrefs instead of
the markdown. The patterns, best-match and canonical rules are unchanged. This arm was priced, not run.

## Profile patterns and canonical form (what the Extract code enforces)

- LinkedIn: `/company/`, `/school/`, `/showcase/` only; country subdomains fold to `www`. The slug
  may contain an apostrophe (`honey-mama's` is a live slug); the source pattern stopped at the
  apostrophe and produced a different URL, fixed here.
- X: `twitter.com` folds to `x.com`, no `www`; share, intent, home, hashtag and `i/` paths rejected.
- Facebook: `web.`, `m.` and locale subdomains fold to `www`; sharer, dialog, plugins, groups rejected.
- Instagram: `p/`, `reel/`, `explore`, `accounts`, `popular` rejected.
- YouTube: `/c/`, `/channel/`, `/user/`, `/@` only.
- TikTok: `/@handle` only.
- Everywhere: https, query string and fragment stripped, trailing `/about`, `/posts`, `/jobs`,
  `/photos`, `/videos`, `/life`, `/featured` stripped, trailing slash stripped. Handles on X,
  Facebook, Instagram, TikTok and YouTube `@` are lowercased (they are case-insensitive), so two
  casings of one handle count as one candidate.
- Best match, never first match: occurrences plus a bonus for appearing in the last fifth of the page,
  where a company's own icons sit. Partner, agency and "powered by" links appear earlier and once.
