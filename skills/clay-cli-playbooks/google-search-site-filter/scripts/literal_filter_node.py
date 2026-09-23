# Code-node body for the Literal filter node (see references/search-workflow.md).
# Keeps only results on the company's own host (minus forum/status/job/staging hosts) whose title or
# snippet literally contains the keyword. Returns a status from a fixed set plus up to 5 candidates.
import json, re
# Hosts where the company is not the one speaking (user forums, status pages, job boards, staging copies).
NOT_COMPANY = re.compile(r'^(community|forum|forums|discuss|answers|feedback|ideas|status|help|jobs|careers|uat|staging|dev)\.', re.I)
def norm(s):
    return re.sub(r'[\s\-]+', ' ', (s or '').lower()).strip()
def literal(text, kw):
    hay, needle = norm(text), norm(kw.replace('"', ''))
    return bool(needle) and (needle in hay or needle.replace(' ', '') in hay.replace(' ', ''))
def handler(context):
    d = context.get('clean') or ''
    k = context.get('keyword') or ''
    res = context.get('serp') or {}
    pages = res.get('results') if isinstance(res, dict) else None
    if not isinstance(pages, list) or not pages or any(isinstance(p, dict) and p.get('#error') for p in pages):
        return {'search_status': 'search_error', 'raw_count': 0, 'on_domain': 0, 'literal': 0, 'candidates': '[]'}
    organic = []
    for p in pages:
        if isinstance(p, dict): organic += (p.get('organicResults') or [])
    on_dom, lit = [], []
    for r in organic:
        u = r.get('url') or ''
        host = re.sub(r'^https?://', '', u).split('/')[0].lower()
        if host.startswith('www.'): host = host[4:]
        if not (host == d or host.endswith('.' + d)): continue
        if NOT_COMPANY.match(host): continue
        on_dom.append(r)
        if literal((r.get('title') or '') + ' ' + (r.get('description') or ''), k):
            lit.append({'url': u, 'title': (r.get('title') or '')[:150], 'snippet': (r.get('description') or '')[:300], 'date': r.get('date') or ''})
    if not organic: status = 'no_results'
    elif not on_dom: status = 'no_company_pages'
    elif not lit: status = 'no_literal_match'
    else: status = 'candidates'
    return {'search_status': status, 'raw_count': len(organic), 'on_domain': len(on_dom), 'literal': len(lit), 'candidates': json.dumps(lit[:5])}
