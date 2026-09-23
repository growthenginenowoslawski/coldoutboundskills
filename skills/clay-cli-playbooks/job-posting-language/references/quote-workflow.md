# The quote workflow: three nodes, built once, run once per board

Verified on Clay CLI 1.3.0 on 2026-09-23. Re-read `clay workflows nodes --help` before building;
node shapes are resolved per workspace. Angle-bracket values are ids the CLI prints back to you.

## 1. Create, and add a manual trigger

```
clay workflows create --name "job-posting-language quotes (safe to delete)"
clay workflows triggers create <wf> --input '{"triggerType":"manual","inputSchema":{"type":"object","properties":{"domain":{"type":"string"},"board_url":{"type":"string"},"keywords":{"type":"string"},"title_words":{"type":"string"},"window_days":{"type":"string"},"today":{"type":"string"}},"required":["domain","board_url","keywords","title_words","window_days","today"]}}'
clay workflows graph get <wf> --mode summary      # the trigger node id
```

## 2. The HTTP node (Clay utility action, 0 credits)

```json
{"nodeType":"tool","name":"Read public job board","incomingEdges":[{"sourceNode":"<trigger>"}],
 "tools":[{"toolType":"clay_action","actionKey":"http-api-v2",
   "actionPackageId":"4299091f-3cd3-4d68-b198-0143575f471d",
   "inputMappingConfig":{"url":{"type":"reference","expression":"{{board_url}}"},
                         "method":{"type":"static","value":"GET"}}}],
 "inputSchema":{"type":"object","required":["board_url"],
   "properties":{"board_url":{"type":"string","sourceNodeId":"<trigger>","sourcePath":"$.board_url"}}}}
```

A static `headers` value must be a JSON **string**, not an object: an object is rejected with
`Validation failed: [tools.0.inputMappingConfig.headers.value] Invalid input`. The public boards
below need no headers at all.

## 3. The matcher node (code, 0 credits)

`code` is the whole of `scripts/posting_match.py`. Pin the board at `$.result` (a tool node's
output sits under `result`) and the other four fields from the trigger at `$.<name>`.

```json
{"nodeType":"code","name":"Match posting language","incomingEdges":[{"sourceNode":"<http node>"}],
 "code":"<contents of scripts/posting_match.py>",
 "inputSchema":{"type":"object","properties":{
   "board":{"type":"object","sourceNodeId":"<http node>","sourcePath":"$.result"},
   "keywords":{"type":"string","sourceNodeId":"<trigger>","sourcePath":"$.keywords"},
   "title_words":{"type":"string","sourceNodeId":"<trigger>","sourcePath":"$.title_words"},
   "window_days":{"type":"string","sourceNodeId":"<trigger>","sourcePath":"$.window_days"},
   "today":{"type":"string","sourceNodeId":"<trigger>","sourcePath":"$.today"}}},
 "outputSchema":{"postings_read":{"type":"number","description":"postings on the board"},
   "matched":{"type":"number","description":"postings matching inside the window"},
   "best_title":{"type":"string","description":"newest matching title"},
   "best_url":{"type":"string","description":"its public URL"},
   "best_date":{"type":"string","description":"its published date"},
   "best_phrase":{"type":"string","description":"the phrase that matched"},
   "other_titles":{"type":"string","description":"up to four more matching titles"},
   "verdict":{"type":"string","description":"matched, no_match_in_window, board_empty"}}}
```

A Lever board returns a top-level JSON array; pinned as `object` it still arrived intact on
2026-09-23.

## 4. Run once per company

```
clay workflows runs test <wf> --inputs '{"domain":"example.com","board_url":"https://api.ashbyhq.com/posting-api/job-board/example","keywords":"cold call|cold calls|cold calling","title_words":"sales development|sdr|bdr","window_days":"30","today":"2026-09-23"}'
clay workflows runs get <wf> <runId>          # status, dataCreditsUsed, actionCreditsUsed
clay workflows runs steps <wf> <runId>        # the matcher's outputs
```

## Board URLs, tried in this order on the company's domain stem

| Board | URL | A miss looks like |
|---|---|---|
| Ashby | `https://api.ashbyhq.com/posting-api/job-board/<stem>` | run `failed`, HTTP 404 on the HTTP node |
| Greenhouse | `https://boards-api.greenhouse.io/v1/boards/<stem>/jobs?content=true` | run `failed`, 404 `Job not found` |
| Lever | `https://api.lever.co/v0/postings/<stem>?mode=json` | run `failed`, or `completed` with `board_empty` when the slug exists with no postings |

`?content=true` on Greenhouse is required: without it the board returns no description, and a
title-only scan is the failure this skill exists to avoid.

## Metering observed

`dataCreditsUsed` was 0 on every run. `actionCreditsUsed` read 0 on some identical runs and 1 on
others while the credit balance did not move (1.5 before and after). Treat it as an
action-execution count on the installer's plan, not a credit charge, and tell the installer it
exists.
