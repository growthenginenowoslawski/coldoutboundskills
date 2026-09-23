# Workflow recipe: the fetch step, built on the installer's workspace

Read live with `clay workflows nodes --help` and `clay workflows actions schema` before building; the
shapes below are what CLI 1.3.0 accepted on 2026-09-23 and are a starting point to re-verify, not a
frozen spec.

## Why a workflow at all

A connected-account action (`paymentType: Bring Your Own Account`) only runs inside a workflow on this
surface. The one out-of-band runner, `clay workflows actions test`, has a small per-workspace daily cap
shared with everyone in the workspace, so a skill must never plan its batch on it. The workflow below is
three nodes, linear, and holds no installer data after the run.

## The three nodes

1. **Manual trigger**, one string input `target_urls` (comma or newline separated).

   ```
   clay workflows create --name "social-posts fetch (safe to delete)"
   clay workflows triggers create <workflow> --input '{"triggerType":"manual","inputSchema":{"type":"object","properties":{"target_urls":{"type":"string"}},"required":["target_urls"]}}'
   clay workflows graph get <workflow> --mode summary      # read the trigger node id
   ```

2. **Code node "Build actor input"** that dedupes and normalises the URLs and writes the actor input as
   one JSON string. The sandbox has no network and no third-party modules (even `urllib` is absent), so
   keep it to `json` and `re`.

   ```python
   import json
   def handler(context):
       raw = context.get("target_urls") or ""
       urls = []
       for u in raw.replace("\n", ",").split(","):
           u = u.strip()
           if not u:
               continue
           if not u.startswith("http"):
               u = "https://" + u
           u = u.split("?")[0].rstrip("/") + "/"
           if u not in urls:
               urls.append(u)
       payload = {"targetUrls": urls, "maxPosts": 3, "postedLimit": "3months",
                  "includeReposts": False, "includeQuotePosts": True,
                  "scrapeReactions": False, "scrapeComments": False}
       return {"payload": json.dumps(payload), "url_count": len(urls)}
   ```

   Node spec: `nodeType: code`, one incoming edge from the trigger, `inputSchema.properties.target_urls`
   pinned with `sourceNodeId` = trigger id and `sourcePath: "$.target_urls"`, and a flat `outputSchema`
   of `payload` (string) and `url_count` (number). Every declared output key must be returned.

   `maxPosts` and `postedLimit` are the installer's window and depth (Declared inputs). Keep reactions
   and comments off: each one bills at the post rate and this job never reads them.

3. **Tool node "Fetch recent posts"**, the connected-account runner:

   ```json
   {"nodeType":"tool","name":"Fetch recent posts",
    "incomingEdges":[{"sourceNode":"<code node id>"}],
    "tools":[{"toolType":"clay_action","actionKey":"apify-run-actor",
              "actionPackageId":"<packageId read from the live catalogue>",
              "authAccountId":"<the installer's connected account id>",
              "inputMappingConfig":{
                "actorId":{"type":"static","value":"harvestapi/linkedin-company-posts"},
                "data":{"type":"reference","expression":"{{payload}}"},
                "limit":{"type":"static","value":30}}}],
    "inputSchema":{"type":"object","required":["payload"],
      "properties":{"payload":{"type":"string","sourceNodeId":"<code node id>","sourcePath":"$.payload"}}}}
   ```

   - `authAccountId` goes **on the tool**, not on the node. On the node the CLI rejects it with
     "authAccountId applies to agent nodes and agent-mode map nodes, not tool nodes".
   - The connected account ids are listed under `availableAppAccounts` on this action in
     `clay workflows actions list`. Ask which one to use when there is more than one; never pick.
   - `actorId` accepted the `publisher/name` form on 2026-09-23. The selectable list from
     `clay workflows actions dynamic-fields <packageId> apify-run-actor actorId --account <id>` shows
     opaque ids and display names only; the public actor endpoint maps an id to its publisher if needed.
   - `limit` caps the items returned into Clay. Set it to URLs × `maxPosts`.

## Run and read

```
clay workflows runs test <workflow> --inputs '{"target_urls":"https://www.linkedin.com/company/example/,https://www.linkedin.com/in/example/"}'
clay workflows runs get <workflow> <runId>        # poll until status is completed or failed
clay workflows runs steps <workflow> <runId>      # the posts are at data[-1].stepOutputs.result.results
```

Measured on the run: `dataCreditsUsed: 0`, `actionCreditsUsed: 1` for the whole batch (one action
execution, not one per URL), and the workspace credit balance did not move. The scraper account is billed
per post by its own vendor; that bill is not visible through Clay, so read it in the vendor's console.

## Fields the skill reads per post item

| Path | Meaning | Trap |
|---|---|---|
| `query.targetUrl` | the URL you asked about | the join key back to your row |
| `author.universalName` | company slug | **null on person items** |
| `author.publicIdentifier` | person slug | null on company items |
| `author.type` | `company` or `profile` | carry it into the output |
| `content` | the post text, verbatim | the deliverable |
| `postedAt.date` | ISO timestamp | compute days ago yourself |
| `linkedinUrl` | the post permalink | the evidence URL |
| `engagement.likes` / `.comments` | counts | not needed here |

**The author-identity gate.** On 2026-09-23 a company URL returned three posts whose authors were three
different accounts (one company, two people), none of them the page asked about, with no repost flag. A
join on `query.targetUrl` alone would have attributed a stranger's post to the prospect. Keep a post only
when its author slug equals the slug in the target URL.

## The Clay-credit arm in the same shape (schema read, not run)

Replace node 3 with a tool node on package "Professional Posts", action
`social-posts-get-post-activity-posts-and-shares`, `socialUrl` pinned to the trigger (one person URL per
run) and `maxActivitiesLimit` static at the declared depth (default 10, maximum 25). No account id: it
bills 0.5 Clay credits per call. Output at `$.result.posts[]`: `content[].text`, `created_at`,
`author.url`, `author.type`, `is_repost_with_no_additional_text_or_content`. Drop reposts with no added
text before screening, and apply the same author gate on `author.url`.
