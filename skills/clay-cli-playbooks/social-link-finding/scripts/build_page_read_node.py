# Code-node body for the Build node of the social page read (see references/page-read-workflow.md).
# Normalizes the domain and builds the page reader's input. The explicit removeElementsCssSelector is
# load-bearing: the reader's default strips nav and footer, which is where social icons live.
import json
def handler(context):
    d = (context.get('domain') or '').strip().lower()
    for p in ('https://', 'http://'):
        if d.startswith(p): d = d[len(p):]
    if d.startswith('www.'): d = d[4:]
    d = d.split('/')[0].split('?')[0]
    ok = bool(d) and '.' in d and ' ' not in d
    inp = {"query": "https://" + (d if ok else 'invalid.invalid') + "/", "maxResults": 1, "outputFormats": ["markdown"],
           "scrapingTool": "raw-http", "removeElementsCssSelector": "noscript", "htmlTransformer": "none",
           "removeCookieWarnings": False, "requestTimeoutSecs": 40}
    return {"clean": d if ok else "invalid", "input_ok": "yes" if ok else "no", "actor_input": json.dumps(inp)}
