# The site-search workflow

Four nodes, linear: trigger (`domain`, `keyword`), `Build query` (code), `SERP` (the web-search tool
on the installer's own connected account), `Literal filter` (code). The two code nodes are free. The
search node runs through Clay's bring-your-own-account action for a hosted scraper, so Clay bills **no
credits** for it and the installer's scraper account bills per search.

Built and run live 2026-09-23 on CLI 1.3.0. Re-confirm every command with `--help` on the installed
version; where a command below is refused, the installed version wins and this file is wrong.

## What was measured on the search node

- **Action:** `apify-run-actor` in the catalogue's Apify package, `paymentType: Bring Your Own
  Account`, no `creditCost`. Inputs: `actorId` (required), `data` (the actor's input as a JSON
  string), `fieldsToReturn`, `limit`. The catalogue declares **no output parameters**; read the real
  shape off `clay workflows runs steps`.
- **Actor:** Apify's public Google search actor, `apify/google-search-scraper`. Result shape:
  `result.results[0].organicResults[]`, each with `url`, `title`, `description`, sometimes `date`.
  `result.results[0]["#error"]` is `false` on a good page.
- **Which connected account ran it** could not be chosen from the CLI: a node-level `authAccountId`
  is rejected for tool nodes ("applies to agent nodes"), and a tool-level one was accepted and stored
  as `null`. The run used the workspace's default connection. If the installer has more than one
  scraper account connected, say that the default one will bill.
- **A second actor needed an approval this skill cannot give.** A different scraper actor refused with
  `full-permission-actor-not-approved`. The Google search actor did not. If the installer's account
  refuses, the approval is theirs to give in their scraper console; this skill never grants it.

## Commands

```
clay workflows create --name "site-keyword search (safe to delete)"                  # -> WF
clay workflows triggers create WF --input '{"triggerType":"manual","inputSchema":{"type":"object","properties":{"domain":{"type":"string"},"keyword":{"type":"string"}},"required":["domain","keyword"]}}'
clay workflows graph get WF --mode summary | jq .summary.nodes                         # -> T
clay workflows nodes create WF --input build.json                                     # -> B
clay workflows nodes create WF --input serp.json                                      # -> SE
clay workflows nodes create WF --input filter.json                                    # -> F
clay workflows runs test WF --inputs '{"domain":"northwind-example.com","keyword":"SOC 2"}'
clay workflows runs get WF RUN ; clay workflows runs steps WF RUN
```

## Node bodies

`build.json` (code: `scripts/build_query_node.py`):

```json
{"nodeType":"code","name":"Build query","incomingEdges":[{"sourceNode":"T"}],
 "code":"<contents of scripts/build_query_node.py>",
 "inputSchema":{"type":"object","required":["domain","keyword"],"properties":{
   "domain":{"type":"string","sourceNodeId":"T","sourcePath":"$.domain"},
   "keyword":{"type":"string","sourceNodeId":"T","sourcePath":"$.keyword"}}},
 "outputSchema":{"clean":{"type":"string","description":"bare domain"},
   "keyword":{"type":"string","description":"keyword, quotes stripped"},
   "query":{"type":"string","description":"the one site: query"},
   "actor_input":{"type":"string","description":"search actor input JSON"},
   "input_ok":{"type":"string","description":"yes or no"}}}
```

`serp.json`:

```json
{"nodeType":"tool","name":"SERP","incomingEdges":[{"sourceNode":"B"}],
 "tools":[{"toolType":"clay_action","actionKey":"apify-run-actor","actionPackageId":"<package id read in Step 0>",
  "inputMappingConfig":{
   "actorId":{"type":"static","value":"apify/google-search-scraper"},
   "data":{"type":"reference","expression":"{{actor_input}}"},
   "limit":{"type":"static","value":"5"}}}],
 "inputSchema":{"type":"object","required":["actor_input"],"properties":{
   "actor_input":{"type":"string","sourceNodeId":"B","sourcePath":"$.actor_input"}}}}
```

`filter.json` (code: `scripts/literal_filter_node.py`). It pins `Build query` two nodes up; that
resolved correctly in this build.

```json
{"nodeType":"code","name":"Literal filter","incomingEdges":[{"sourceNode":"SE"}],
 "code":"<contents of scripts/literal_filter_node.py>",
 "inputSchema":{"type":"object","required":["clean","keyword"],"properties":{
   "clean":{"type":"string","sourceNodeId":"B","sourcePath":"$.clean"},
   "keyword":{"type":"string","sourceNodeId":"B","sourcePath":"$.keyword"},
   "serp":{"type":"object","sourceNodeId":"SE","sourcePath":"$.result"}}},
 "outputSchema":{"search_status":{"type":"string","description":"candidates|no_literal_match|no_company_pages|no_results|search_error"},
   "raw_count":{"type":"number","description":"organic results returned"},
   "on_domain":{"type":"number","description":"results on the company's own hosts"},
   "literal":{"type":"number","description":"results literally containing the keyword"},
   "candidates":{"type":"string","description":"JSON list of up to 5 {url,title,snippet,date}"}}}
```

## Gotcha that cost a debug cycle

A regex written inside a Python triple-quoted string inside a JSON file got its backslashes doubled
twice, so the whitespace-collapse pattern matched a literal backslash and every row came back
`no_results`. Keep the code in its own `.py` file and load it into the JSON with a script rather than
hand-escaping it.

## A search-free fallback (partly measured)

If the installer has no web-search account: the free Clay action `get-sitemap` (`identifier` = the
domain, `keywords` = a path word such as `security`) lists matching sitemap URLs. Measured: 6 URLs
for one SaaS domain, and `total_found: 0` with "No Sitemap Pages found" for another. Reading those
pages for the literal phrase then needs the paid page scraper (`scrape-website`, `bodyText`, 1 credit
per page read live on 2026-09-23), which was not run. It finds only what the sitemap exposes and the
path word guesses.
