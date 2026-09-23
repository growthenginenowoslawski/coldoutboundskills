# What counts as evidence, per technology

Three evidence classes, strongest first. The free Clay gate can read the first two; the third needs a
page read, which is a paid step on Clay (see the SKILL.md cost table).

1. **Response header set by the vendor's own edge.** A page that merely talks about the vendor cannot
   put it there. Confirms on its own.
2. **Technology oracle**: a vendor endpoint that answers the question outright and returns JSON, so the
   HTTP action keeps the body. Confirms on its own when the JSON has the expected shape.
3. **Vendor-hosted asset in the HTML** (a script loaded from the vendor's CDN). Strong for a widget
   (martech, chat, reviews), **never enough for a platform claim**: agency portfolios, app-review
   roundups and Buy-Button sites all carry a platform's CDN URL without running the platform.

A bare product name in page text is not evidence of anything.

## Header registry (what `scripts/grade_node.py` checks)

| Technology | Header : pattern | Kind | Status on 2026-09-23 |
|---|---|---|---|
| Shopify | `x-shopid` any · `x-shopify-stage` any · `powered-by` ~ shopify · `x-sorting-hat-shopid` any | platform | fired live on 1 storefront (`powered-by: Shopify, Oxygen, Hydrogen`) |
| WordPress | `link` ~ `api.w.org` · `x-powered-by` ~ WP Engine · `x-pingback` ~ xmlrpc.php | platform | fired live on 1 publisher site (`link: <.../wp-json/>; rel="https://api.w.org/"`), oracle agreed |
| Wix | `x-wix-request-id` any | platform | not observed live |
| Squarespace | `server` ~ Squarespace | platform | not observed live |
| HubSpot CMS | `x-hs-hub-id` any · `x-powered-by` ~ HubSpot | platform | not observed live |
| Webflow | `x-wf-region` any · `surrogate-key` ~ webflow | platform | not observed live |
| Next.js | `x-powered-by` ~ Next.js · `x-nextjs-cache` any | framework | fired live on 1 former storefront now headless |
| Vercel, Cloudflare | `x-vercel-id`, `server: vercel` · `server: cloudflare`, `cf-ray` | infra | fired often; reported as `infra`, never as a result |

Only Shopify's header set carries prior validation (a 10-domain check against its oracle, 2026-08-04,
recorded in the playbook this skill was ported from). Every other row is a plausible pattern, not a
tested one. Before a campaign depends on one, run the ritual below.

## Oracles

| Technology | Oracle | Positive | Negative | Inconclusive |
|---|---|---|---|---|
| Shopify | GET the site root plus `products.json?limit=1` | 200 and a JSON body with a `products` key | 404, or 200 without that JSON shape (a soft-404 page) | 401/403/413/429/5xx, transport error |
| WordPress | GET the site root plus `wp-json/` | 200 and a JSON body with a `namespaces` key | 404, or 200 without that shape | same |

**Headless storefronts break the Shopify oracle.** Measured 2026-09-23: a storefront running Shopify's
headless stack returned the Shopify `powered-by` header on the homepage and **404** on
`products.json`. So the header outranks the oracle in `grade_node.py`: a header hit confirms even when
the oracle says no. An oracle "no" only produces `not_detected` when no header fired.

**A 413 is not a 404.** One large publisher answered both the homepage and the oracle with HTTP 413
from Clay's fetcher. The first version of the grader counted any non-404 4xx on the oracle as a clean
"no" and reported `not_detected`; the fix treats every status other than 404 and a well-shaped 200 as
inconclusive. That is the rule now in the script.

## Markers for a page read (paid, not run in this build)

If the installer approves a page read for `unconfirmed` or `blocked` rows, these are the vendor-asset
patterns to search the raw HTML for. They come from the source playbook's registry, where the bare
vendor-domain versions were removed after they fired on partner and review pages.

| Technology | Kind | HTML pattern |
|---|---|---|
| Shopify | platform (needs header or oracle too) | `cdn.shopify.com`, `*.myshopify.com`, `Shopify.theme` |
| Shopify Buy Button | embed, NOT a storefront | `sdks.shopifycdn.com/buy-button` |
| Klaviyo | martech | `static.klaviyo.com`, `klaviyo.js` |
| Attentive | martech | `cdn.attn.tv` |
| HubSpot (forms, tracking) | martech | `js.hs-scripts.com`, `js.hsforms.net` |
| Intercom | support | `widget.intercom.io`, `intercomcdn.com` |
| Zendesk | support | `static.zdassets.com` |
| Gorgias | support | `gorgias.chat`, `config.gorgias.io` |
| Segment | martech | `cdn.segment.com/analytics.js` |
| Recharge | martech | `static.rechargecdn.com`, `cdn.rechargeapps.com` |
| Yotpo | martech | `staticw2.yotpo.com` |
| Okendo | martech | `cdn.okendo.io` |
| WooCommerce | platform | `wp-content/plugins/woocommerce/`, `wc-ajax=` |
| Webflow | platform | `assets.website-files.com`, `cdn.prod.website-files.com`, `data-wf-site` |
| Squarespace | platform | `static1.squarespace.com` |
| Wix | platform | `static.parastorage.com` |

A page-read tool that returns "readable content" rather than raw HTML strips `<script>` tags and
footers. Measured 2026-09-23 on one storefront through a bring-your-own-account page reader: 134 KB of
HTML came back with **zero** `<script` tags and zero CDN matches. Whatever reads the page for this step
has to return raw HTML, and its output has to be checked for script tags before a zero is believed.

## Adding a technology: the 3-and-3 ritual

1. Three companies you know run it, three you know do not, at least one negative in the same industry
   as the positives (that is where fingerprints collide).
2. Run all six through the gate.
3. Require 3/3 confirmed on the positives and 0/3 on the negatives. A `blocked` row proves nothing
   either way; replace it.
4. Prefer a header or an oracle. If the only thing separating users from non-users is the product
   name in body text, the technology is not detectable from the website and this skill cannot target
   it. Say so.
5. Record the date and the six domains beside the row above.

## Not detectable from a website

Shopify Plus versus Shopify (identical markup and headers), anything behind a login, and back-office
systems (ERP, warehouse, a CRM with no public form or chat widget).
