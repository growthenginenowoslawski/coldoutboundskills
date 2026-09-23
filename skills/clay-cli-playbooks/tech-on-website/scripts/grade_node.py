# Code-node body for the Grade node of the tech-on-website gate (see references/gate-workflow.md).
# Reads homepage status + headers and the oracle response; emits one verdict from a fixed set.
# Verdicts: confirmed | not_detected | blocked | unconfirmed. Header evidence outranks the oracle.
import json, re
BLOCKED = {401, 403, 405, 429, 503}
# header fingerprints only: http-api-v2 returns headers but discards HTML bodies
HEADER_FP = {
    'Shopify': [('x-shopid', r'.+'), ('x-shopify-stage', r'.+'), ('powered-by', r'shopify'), ('x-sorting-hat-shopid', r'.+')],
    'Wix': [('x-wix-request-id', r'.+')],
    'Squarespace': [('server', r'squarespace')],
    'WordPress': [('link', r'api\.w\.org'), ('x-powered-by', r'wp engine'), ('x-pingback', r'xmlrpc\.php')],
    'HubSpot CMS': [('x-hs-hub-id', r'.+'), ('x-powered-by', r'hubspot')],
    'Webflow': [('x-wf-region', r'.+'), ('surrogate-key', r'webflow')],
    'Next.js': [('x-powered-by', r'next\.js'), ('x-nextjs-cache', r'.+')],
    'Vercel': [('x-vercel-id', r'.+'), ('server', r'^vercel$')],
    'Cloudflare': [('server', r'cloudflare'), ('cf-ray', r'.+')],
}
INFRA = {'Cloudflare', 'Vercel'}
def hget(h, k):
    for kk, vv in (h or {}).items():
        if kk.lower() == k:
            return ' '.join(vv) if isinstance(vv, list) else str(vv)
    return None
def status_of(r):
    if not isinstance(r, dict): return None
    s = r.get('statusCode')
    try: return int(s)
    except Exception: return None
def handler(context):
    target = (context.get('target') or '').strip()
    home = context.get('home') or {}
    orc = context.get('oracle') or {}
    hs = status_of(home); os_ = status_of(orc)
    h = home.get('headers') if isinstance(home, dict) else {}
    challenge = (hget(h, 'cf-mitigated') or '').lower() == 'challenge'
    home_blocked = hs is None or hs in BLOCKED or hs >= 400 or challenge
    if not home_blocked: reason = ''
    elif hs is None: reason = 'transport_error'
    elif hs >= 400: reason = 'http_%d' % hs + ('_challenge' if challenge else '')
    else: reason = 'challenge_%d' % hs
    hits, ev = [], {}
    if not home_blocked:
        for name, pats in HEADER_FP.items():
            for k, pat in pats:
                v = hget(h, k)
                if v and re.search(pat, v, re.I):
                    hits.append(name); ev[name] = 'header %s: %s' % (k, v[:60]); break
    signal = [x for x in hits if x not in INFRA]
    # oracle
    oracle = 'none'
    if context.get('has_oracle') == 'yes':
        body = orc.get('body') if isinstance(orc, dict) else None
        if os_ == 404: oracle = 'no'
        elif os_ == 200 and isinstance(body, dict) and ('products' in body or 'namespaces' in body): oracle = 'yes'
        elif os_ == 200: oracle = 'no'  # 200 without the JSON shape is a soft-404, not a storefront
        else: oracle = 'inconclusive'  # 401/403/413/429/5xx/transport: never a negative
    tl = target.lower()
    in_headers = any(x.lower() == tl for x in signal)
    if in_headers:
        verdict, evidence = 'confirmed', ev[[x for x in signal if x.lower() == tl][0]]
    elif oracle == 'yes':
        verdict, evidence = 'confirmed', 'oracle 200 on ' + ('/products.json' if tl == 'shopify' else '/wp-json/')
    elif oracle == 'no' and not home_blocked:
        verdict, evidence = 'not_detected', 'oracle said no (HTTP %s) and no vendor header' % os_
    elif oracle == 'no' and home_blocked:
        verdict, evidence = 'not_detected', 'oracle said no (HTTP %s); homepage blocked' % os_
    elif home_blocked:
        verdict, evidence = 'blocked', 'homepage ' + reason + ('; oracle inconclusive' if oracle == 'inconclusive' else '')
    else:
        verdict, evidence = 'unconfirmed', 'no vendor header for target and no free oracle; needs a page read'
    return {'verdict': verdict, 'evidence': evidence, 'header_stack': ', '.join(signal) or '', 'infra': ', '.join(x for x in hits if x in INFRA),
            'home_status': str(hs), 'oracle_status': str(os_) if context.get('has_oracle') == 'yes' else 'n/a', 'oracle': oracle, 'blocked_reason': reason}
