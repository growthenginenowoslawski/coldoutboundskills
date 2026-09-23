# Code-node body for the Build query node (see references/search-workflow.md).
# One domain, one keyword, one quoted phrase. Never an OR chain. Pure Python, no network.
import json, re
def handler(context):
    d = (context.get('domain') or '').strip().lower()
    for p in ('https://', 'http://'):
        if d.startswith(p): d = d[len(p):]
    if d.startswith('www.'): d = d[4:]
    d = d.split('/')[0].split('?')[0]
    k = (context.get('keyword') or '').strip().replace('"', '')
    chained = bool(re.search(r'\bOR\b|\||\bAND\b', k))
    ok = bool(d) and '.' in d and ' ' not in d and bool(k) and not chained
    q = 'site:' + d + ' "' + k + '"'
    actor_input = {"queries": q, "resultsPerPage": 10, "maxPagesPerQuery": 1, "countryCode": "us",
                   "languageCode": "en", "mobileResults": False, "saveHtml": False,
                   "saveHtmlToKeyValueStore": False, "includeUnfilteredResults": False}
    return {'clean': d or 'invalid', 'keyword': k or 'unset', 'query': q,
            'actor_input': json.dumps(actor_input), 'input_ok': 'yes' if ok else 'no'}
