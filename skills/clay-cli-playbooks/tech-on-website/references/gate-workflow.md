# The live-site gate as a Clay workflow

A four-node linear workflow: trigger, then `Clean` (code), `Home` (HTTP GET of the homepage),
`Oracle` (HTTP GET of the technology's JSON endpoint), `Grade` (code). Every node is free: the two
HTTP nodes use the Clay utility action `http-api-v2`, which carries no credit price, and code nodes do
not bill. Each run does consume **action executions** (1 to 2 per row were reported on the run
record, `actionCreditsUsed`), which are a different meter from credits.

Built and run live 2026-09-23 on CLI 1.3.0. Re-confirm every command with `--help` on the installed
version; if a command or flag below is refused, the installed version wins and this file is wrong.

## Why the graph looks like this

- **Linear only.** A node with two incoming edges is a join and waits forever. `Grade` reads the
  outputs of `Clean`, `Home` and `Oracle` through input pins, not through extra edges.
- **Pins two hops back resolved fine in this build** (`Grade` pins `Clean`, three nodes up), as long
  as the pin names the source node id and a `$.`-rooted path. Tool-node outputs live under
  `$.result`; code-node outputs live at `$`.
- **Static tool inputs are strings.** `headers` passed as a JSON object failed validation
  (`inputMappingConfig.headers.value Invalid input`); the same headers as a JSON **string**
  were accepted. Booleans and numbers were passed as `"true"` / `"20000"`.
- **`returnResponseMetadata: "true"` is what makes this gate possible.** It adds `statusCode` and the
  full response `headers` to the result. Without it you get the body only.
- **The HTTP action discards non-JSON bodies.** Measured on five URLs (an HTML homepage returning 200,
  a `text/plain` robots file, and three storefronts): `result.body` came back `{}` every time while
  `statusCode` and `headers` were intact. That is why this gate reads headers and JSON oracles only,
  and why a script-tag fingerprint (a martech widget) cannot be confirmed on the free path.

## Commands

```
clay workflows create --name "tech-on-website gate (safe to delete)"            # -> .id  = WF
clay workflows triggers create WF --input '{"triggerType":"manual","inputSchema":{"type":"object","properties":{"domain":{"type":"string"},"target_tech":{"type":"string"}},"required":["domain","target_tech"]}}'
clay workflows graph get WF --mode summary | jq .summary.nodes                   # -> trigger node id = T
clay workflows nodes create WF --input clean.json                                # -> C
clay workflows nodes create WF --input home.json                                 # -> H
clay workflows nodes create WF --input oracle.json                               # -> O
clay workflows nodes create WF --input grade.json                                # -> G
clay workflows runs test WF --inputs '{"domain":"northwind-example.com","target_tech":"Shopify"}'   # -> runId
clay workflows runs get WF RUN          # poll until .status is not running; read .dataCreditsUsed, .actionCreditsUsed
clay workflows runs steps WF RUN        # .data[-1].stepOutputs is the Grade node's verdict
```

`nodes create` returned `{"nodeId": ..., "operation": "created"}` on this version; read the id from
`nodeId`, or re-read the graph summary.

## Node bodies

Replace `T`, `C`, `H`, `O` with the ids you got back.

`clean.json` (code: `scripts/clean_node.py`):

```json
{"nodeType":"code","name":"Clean","incomingEdges":[{"sourceNode":"T"}],
 "code":"<contents of scripts/clean_node.py>",
 "inputSchema":{"type":"object","required":["domain","target_tech"],"properties":{
   "domain":{"type":"string","sourceNodeId":"T","sourcePath":"$.domain"},
   "target_tech":{"type":"string","sourceNodeId":"T","sourcePath":"$.target_tech"}}},
 "outputSchema":{"clean":{"type":"string","description":"bare domain"},
   "home_url":{"type":"string","description":"https homepage"},
   "oracle_url":{"type":"string","description":"technology oracle URL"},
   "has_oracle":{"type":"string","description":"yes or no"},
   "target":{"type":"string","description":"target technology"}}}
```

`home.json`:

```json
{"nodeType":"tool","name":"Home","incomingEdges":[{"sourceNode":"C"}],
 "tools":[{"toolType":"clay_action","actionKey":"http-api-v2","actionPackageId":"<Clay utility packageId>",
  "inputMappingConfig":{
   "url":{"type":"reference","expression":"{{home_url}}"},
   "method":{"type":"static","value":"GET"},
   "headers":{"type":"static","value":"{\"User-Agent\": \"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36\", \"Accept\": \"text/html,application/xhtml+xml\"}"},
   "returnResponseMetadata":{"type":"static","value":"true"},
   "shouldRetry":{"type":"static","value":"false"},
   "responseTimeout":{"type":"static","value":"20000"}}}],
 "inputSchema":{"type":"object","required":["home_url"],"properties":{
   "home_url":{"type":"string","sourceNodeId":"C","sourcePath":"$.home_url"}}}}
```

`oracle.json` is the same tool with `"name":"Oracle"`, the incoming edge from `H`, `url` bound to
`{{oracle_url}}` pinned from `C`, and `Accept: application/json,text/plain,*/*`. When the target has no
oracle, `Clean` points `oracle_url` at the homepage and `Grade` ignores the result: one wasted free
call, and the graph stays linear.

`grade.json` (code: `scripts/grade_node.py`):

```json
{"nodeType":"code","name":"Grade","incomingEdges":[{"sourceNode":"O"}],
 "code":"<contents of scripts/grade_node.py>",
 "inputSchema":{"type":"object","required":["target","has_oracle"],"properties":{
   "target":{"type":"string","sourceNodeId":"C","sourcePath":"$.target"},
   "has_oracle":{"type":"string","sourceNodeId":"C","sourcePath":"$.has_oracle"},
   "home":{"type":"object","sourceNodeId":"H","sourcePath":"$.result"},
   "oracle":{"type":"object","sourceNodeId":"O","sourcePath":"$.result"}}},
 "outputSchema":{"verdict":{"type":"string","description":"confirmed|not_detected|blocked|unconfirmed"},
   "evidence":{"type":"string","description":"the header or oracle that decided it"},
   "header_stack":{"type":"string","description":"non-infra technologies seen in headers"},
   "infra":{"type":"string","description":"CDN/host seen in headers"},
   "home_status":{"type":"string","description":"homepage HTTP status"},
   "oracle_status":{"type":"string","description":"oracle HTTP status or n/a"},
   "oracle":{"type":"string","description":"yes|no|inconclusive|none"},
   "blocked_reason":{"type":"string","description":"http_403, challenge_200, transport_error, or empty"}}}
```

Every key declared in `outputSchema` must be returned by the handler, on every branch, or the run
fails. Both scripts do.

## Running a list

`clay workflows runs test` takes one input object per run. Loop the rows and cap concurrency; this
build ran 13 rows at once without a rate-limit error, and a larger ceiling was not measured. Read the
first result before starting the rest, and stop the loop on the first run whose `.status` is not
`completed`.

## Cleanup

The workflow is a draft (never published) and holds no data of yours beyond run logs. Delete it with
`clay workflows delete WF` when the installer says so; this skill never deletes it on its own.
