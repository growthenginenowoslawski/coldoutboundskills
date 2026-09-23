# Workflow recipes: find the page, prove it, read the ads

Shapes accepted by CLI 1.3.0 on 2026-09-23. Re-verify with `clay workflows nodes --help` and
`clay workflows actions schema` before building. Two small linear workflows, kept separate on purpose:
the first is free and decides which rows may reach the second, which is the only one that bills.

## Workflow A: page discovery from the homepage (free)

1. Manual trigger, input `domain` (string, required).
2. Code node "Clean domain": lowercase, strip scheme, `www.` and path; output `clean_domain` and
   `home_url` (`https://<domain>/`).
3. Tool node "Fetch homepage": Clay utility action `http-api-v2` (package read from the live catalogue),
   `method` GET, `url` reference `{{home_url}}`, a browser `User-Agent` header, `followRedirects` true,
   `shouldRetry` false, `responseTimeout` 20000.

   **Do not set `returnResponseMetadata`.** With it on, an HTML page comes back as `body: {}` (the body is
   parsed as JSON and an HTML document parses to nothing) and every row looks like "no link". With it off,
   `$.result` is the raw HTML string. Measured on the same URL both ways, 2026-09-23.

   A 403, 429 or refused connection **fails the node**; the run status is `failed` and the error text
   carries the status code. That is `fetch_blocked`, not "no page".
4. Code node "Find and gate Facebook page", inputs `html` pinned to `$.result` of node 3 and
   `clean_domain` pinned to node 2 (a two-hop pin; it resolved correctly):

   ```python
   import re
   BAD = {"sharer", "sharer.php", "plugins", "tr", "profile.php", "groups", "photo.php", "posts",
          "videos", "dialog", "share", "pages", "events", "watch", "hashtag", "login", "help",
          "policies", "business", "ads", "people", "story.php", "permalink.php", "l.php"}
   def squash(s):
       return re.sub(r"[^a-z0-9]", "", (s or "").lower())
   def handler(context):
       html = context.get("html")
       domain = (context.get("clean_domain") or "").lower()
       label = squash(domain.split(".")[0]) if domain else ""
       if not isinstance(html, str) or len(html) < 200:
           return {"fb_page_url": "", "status": "fetch_failed", "candidates": "", "reason": "no HTML"}
       text = html.replace("\\/", "/")
       slugs = []
       for m in re.finditer(r"https?://(?:www\.|m\.|web\.)?facebook\.com/([A-Za-z0-9.\-_]+)", text):
           s = m.group(1).strip(".")
           if s and s.lower() not in BAD and not s.isdigit() and s not in slugs:
               slugs.append(s)
       if not slugs:
           return {"fb_page_url": "", "status": "no_link", "candidates": "", "reason": "no page link"}
       for s in slugs:
           q = squash(s)
           if label and (q.startswith(label) or label.startswith(q)):
               return {"fb_page_url": "https://www.facebook.com/" + s + "/", "status": "verified",
                       "candidates": ",".join(slugs[:5]), "reason": "slug matches domain label"}
       return {"fb_page_url": "", "status": "unverified", "candidates": ",".join(slugs[:5]),
               "reason": "slug does not match the domain label"}
   ```

## Workflow B: read the ad library (connected account; the only billed step)

1. Manual trigger, optional inputs `fb_page_url`, `keyword`, `country`.
2. Code node "Build ad query". The sandbox has no `urllib`; percent-encode by hand.

   ```python
   import json
   SAFE = set("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.~")
   def quote(t):
       return "".join(c if c in SAFE else "".join("%%%02X" % b for b in c.encode("utf-8")) for c in t)
   def handler(context):
       page = (context.get("fb_page_url") or "").strip()
       kw = (context.get("keyword") or "").strip()
       country = (context.get("country") or "US").strip().upper() or "US"
       if page:
           return {"actor_input": json.dumps({"startUrls": [{"url": page}], "onlyTotal": True,
                                              "activeStatus": "active"}), "mode": "page", "item_cap": 1}
       if kw:
           url = ("https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country="
                  + country + "&q=" + quote(kw) + "&search_type=keyword_unordered")
           return {"actor_input": json.dumps({"startUrls": [{"url": url}], "resultsLimit": 8,
                                              "activeStatus": "active"}), "mode": "keyword", "item_cap": 8}
       return {"actor_input": "", "mode": "none", "item_cap": 0}
   ```

3. Tool node "Read ad library": `apify-run-actor`, `authAccountId` **on the tool**, `actorId` static
   `apify/facebook-ads-scraper`, `data` reference `{{actor_input}}`, `limit` 10.

`fb_page_url` accepts either a page URL or an ad-library URL with `view_all_page_id=<page id>`; the
second is how a page id proven in keyword mode becomes a count. Both returned `totalCount` plus up to 30
ads in one item on 2026-09-23.

### Two billing shapes

| Mode | Input | What comes back | Billing (source build, 2026-08-04, vendor console) |
|---|---|---|---|
| page | `onlyTotal: true` + page | one item: `totalCount`, `pageInfo.page.name`, up to 30 ads in `results[]` | one item per page |
| keyword | ad-library search URL + `resultsLimit` | one item per ad, any advertiser | one item per ad |

Omitting `onlyTotal` on a page flips billing to one item per ad. The vendor bill is not visible through
Clay; the run reports `dataCreditsUsed: 0` and one action execution.

### Fields read per ad

| Path | Meaning | Trap |
|---|---|---|
| `pageName`, `pageId` | the advertiser | in keyword mode most rows can be other advertisers |
| `snapshot.linkUrl` | the landing page | **the identity proof in keyword mode**: host must equal a declared brand domain |
| `snapshot.body.text` | ad copy | can be a catalog template such as a double-brace product token; skip those |
| `snapshot.title`, `snapshot.ctaText` | headline, button | titles are often template tokens too |
| `startDateFormatted`, `isActive` | when it started, still running | carry the start date as evidence |
| `totalCount` (page mode, on the item) | ads Meta reports for the page | collates duplicates; never quote it |
