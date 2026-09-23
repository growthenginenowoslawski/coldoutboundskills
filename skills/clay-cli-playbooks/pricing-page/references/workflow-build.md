# Building the probe workflow (node shapes, verified 2026-09-23 on CLI 1.3.0)

Re-check every shape with `clay workflows nodes --help` and `clay workflows actions schema` on your
installed version; if the live schema disagrees, it wins.

## Trigger

```
clay workflows create --name "pricing probe (safe to delete)"          # -> .id
clay workflows triggers create <wf> --input '{"triggerType":"manual","inputSchema":{"type":"object","properties":{"domain":{"type":"string"}},"required":["domain"]}}'
clay workflows graph get <wf> --mode summary | jq .summary.nodes          # the trigger node id
```

## Tool node (URL checker, redirect finder, sitemap)

String interpolation inside a reference expression works: `"{{base}}/pricing"`, where `base` is
the scheme plus canonical host emitted by the code node below.
Static header objects must be passed as a JSON *string*, not an object (an object was rejected with
`validation_error`).

```json
{"nodeType":"tool","name":"status /pricing","incomingEdges":[{"sourceNode":"<previous node>"}],
 "tools":[{"toolType":"clay_action","actionKey":"check-url","actionPackageId":"<resolved packageId>",
   "inputMappingConfig":{"url":{"type":"reference","expression":"{{base}}/pricing"}}}],
 "inputSchema":{"type":"object","required":["base"],
   "properties":{"base":{"type":"string","sourceNodeId":"<canonical-host code node>","sourcePath":"$.base"}}}}
```

The redirect finder is the same shape with `get-page-redirect` and the parameter `link`. Its
`result` is `{}` when there is no redirect and `{"redirectLink": "..."}` when there is.

The sitemap node takes `identifier` (the domain) and `keywords` as a static JSON array:
`"keywords":{"type":"static","value":["pricing","plans"]}`.
Results are capped (300 links were returned on one large site) and include every locale variant.

## Canonical-host code node

Placed after a `get-page-redirect` whose `link` is the bare `{{domain}}` (both the redirect finder
and the URL checker accepted a bare domain). Pin the redirect node's `$.result`
as an object; an empty `{}` pin did not fail the run.

```python
def handler(context):
    d = (context.get('domain') or '').strip().lower().replace('https://','').replace('http://','').split('/')[0]
    res = context.get('root') or {}
    link = res.get('redirectLink') if isinstance(res, dict) else None
    host = d
    if link:
        h = link.split('//', 1)[-1].split('/')[0].lower()
        if h.replace('www.', '') == d.replace('www.', ''):
            host = h
    return {'host': host, 'base': 'https://' + host}
```

`outputSchema` is a flat map: `{"host":{"type":"string","description":"canonical host"},"base":{"type":"string","description":"scheme plus host"}}`.

## Reading a run

```
clay workflows runs test <wf> --inputs '{"domain":"northwind.example"}'   # -> runId
clay workflows runs get <wf> <runId>                                      # .status, .dataCreditsUsed, .actionCreditsUsed
clay workflows runs steps <wf> <runId>                                    # .data[].nodeName, .stepOutputs, .errors
```

`actionCreditsUsed` counted action executions (6 per domain for the five-path probe with the canonical-host step) while
`dataCreditsUsed` stayed 0 and the credit balance did not move. A timed-out sitemap shows the run
`failed` with `errors: ["Tool execution failed with status: ERROR_TIMEOUT"]`.

## What the free HTTP action is not good for here

The generic HTTP action returns `body: {}` for an HTML page (it parses JSON only) and, with a
browser User-Agent, returned `400` from two bot-protected origins where the URL checker saw `200`.
Use it for JSON endpoints, not for page existence or page text.

## Measured timings (2026-09-23, shared workspace)

Five-path probe: 33 to 60 s per domain. Sitemap: 7 to 53 s, timeout at about 110 s. One page fetch
through an own-account actor: 8 to 38 s.
