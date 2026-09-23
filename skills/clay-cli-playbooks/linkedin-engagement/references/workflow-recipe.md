# Workflow recipe: pulling reactors and commenters

Shapes accepted by CLI 1.3.0 on 2026-09-23. Re-verify with `clay workflows nodes --help` and
`clay workflows actions schema` before building; treat this as a starting point, not a frozen spec.

## Why a workflow

Both arms are catalogue actions, and on this surface a catalogue action runs inside a workflow. The only
out-of-band runner, `clay workflows actions test`, has a small daily cap shared by the whole workspace,
so never plan a batch on it. The workflow is four linear nodes and holds nothing after the run.

## Connected-account arm (measured)

1. **Manual trigger** with `post_urls` (string, comma or newline separated, required) and
   `max_per_post` (number).
2. **Code node "Build actor inputs"**. No network, no third-party modules in the sandbox.

   ```python
   import json
   def handler(context):
       raw = context.get("post_urls") or ""
       n = context.get("max_per_post") or 25
       try:
           n = int(n)
       except Exception:
           n = 25
       n = max(1, min(n, 100))
       posts = []
       for u in raw.replace("\n", ",").split(","):
           u = u.strip()
           if u and "linkedin.com" in u and u not in posts:
               posts.append(u)
       cap = n * max(1, len(posts))
       reactions = {"posts": posts, "maxItems": cap, "profileScraperMode": "main"}
       comments = {"posts": posts, "maxItems": cap, "profileScraperMode": "main", "scrapeReplies": False}
       return {"reactions_input": json.dumps(reactions), "comments_input": json.dumps(comments),
               "post_count": len(posts), "item_cap": cap}
   ```

   Flat `outputSchema`: `reactions_input`, `comments_input` (string), `post_count`, `item_cap` (number).

3. **Tool node "Pull reactors"**: action `apify-run-actor` (package read from the live catalogue),
   `authAccountId` set **on the tool** (the node rejects it), `actorId` static
   `harvestapi/linkedin-post-reactions`, `data` reference `{{reactions_input}}`, `limit` reference
   `{{item_cap}}`. Pin `reactions_input` and `item_cap` to the code node with `sourcePath: "$.<name>"`.
4. **Tool node "Pull commenters"**, incoming edge from node 3, same shape with actor
   `harvestapi/linkedin-post-comments` and `{{comments_input}}`, **pinned to the code node two hops
   back**. That two-hop pin resolved correctly on 2026-09-23.

`profileScraperMode: "main"` is load-bearing. The default returns an obfuscated profile id instead of a
public profile URL and no employer, which nothing downstream can match or enrich.

Run it:

```
clay workflows runs test <workflow> --inputs '{"post_urls":"<post permalink>","max_per_post":5}'
clay workflows runs get <workflow> <runId>        # until completed or failed
clay workflows runs steps <workflow> <runId>      # items at .stepOutputs.result.results on each tool node
```

Measured: `dataCreditsUsed: 0`, balance unchanged. The scraping vendor bills per engager and per
profile read, outside Clay.

### Fields read per item

| Path | Meaning | Trap |
|---|---|---|
| `query.post` | the post permalink asked about | the join key. Present on every item. Post items key on `id`, engagement items on `postId`; joining on those attaches the wrong post |
| `actor.type` | `company` on a company page, absent or `profile` on a person | company pages react and comment; drop them |
| `actor.linkedinUrl` | public profile URL on a person | on a company page it is a company URL |
| `actor.currentPosition[]` | current roles, each with `companyName`, `companyUniversalName`, `companyLinkedinUrl`, `position` | **use this, or `experience[]` filtered on `endDate.text == "Present"`**. A current role carries `endDate: {"text":"Present"}`, not a missing end date |
| `actor.headline` / `actor.position` | the profile headline | practitioner and agency tells live here |
| `actor.location.parsed.countryCode` | two-letter country | missing on company pages |
| `reactionType` | `LIKE`, `PRAISE`, `EMPATHY`, … | reactions only |
| `commentary` | the comment text | comments only; never quote it back to the person |

## Clay-credit arm (schema read, not run)

Package "Professional Posts": `social-posts-get-post-interaction-reactions` (`postUrl`,
`maxInteractionsLimit` default 10, max 50) and `social-posts-get-post-interaction-comments`
(`postUrl`, `maxInteractionsLimit` default 10, max 10), each 0.5 credits per post, `paymentType: Clay
Credits`. One tool node per action, `postUrl` pinned to the trigger. Output lives at
`$.result.reactions[]` and `$.result.comments[]`: `author.name`, `author.url`, `author.type`,
`interaction_type`, `reaction`, and on comments `author.title`.

What earlier builds measured on this family and a schema read cannot show: an undeclared `headline` on
reactors (the field that identifies the person), `preview_text` on a reaction being a synthesised
"Like by …" label rather than content, and 48 returned against 50 requested. The reactions payload
carries no employer, so the source-company drop needs a person enrichment per engager on this arm.
