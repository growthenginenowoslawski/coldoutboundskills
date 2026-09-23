# Code-node body for the Extract node of the social page read (see references/page-read-workflow.md).
# Profile-only patterns per platform, best match (count + footer bonus) not first match, canonical
# URLs built here and never by a model. page_status: read | thin | blocked | unreadable.
import json, re
PAT = {
  'linkedin': r"https?://(?:[a-z]{2,3}\.)?linkedin\.com/(?:company|school|showcase)/[A-Za-z0-9._%+\-]+(?:'[A-Za-z0-9]+)?",
  'x': r'https?://(?:www\.)?(?:twitter|x)\.com/(?!share|intent|home|hashtag|i/)[A-Za-z0-9_]{1,15}(?![A-Za-z0-9_])',
  'facebook': r'https?://(?:www\.|web\.|m\.|[a-z]{2}-[a-z]{2}\.)?facebook\.com/(?!sharer|share|dialog|tr\?|plugins|groups)[A-Za-z0-9._%+\-]+',
  'instagram': r'https?://(?:www\.)?instagram\.com/(?!p/|reel/|explore|accounts|popular)[A-Za-z0-9._]+',
  'youtube': r'https?://(?:www\.)?youtube\.com/(?:c/|channel/|user/|@)[A-Za-z0-9._%\-]+',
  'tiktok': r'https?://(?:www\.)?tiktok\.com/@[A-Za-z0-9._]+',
}
CHALLENGE = ['just a moment', 'cf_chl_opt', '/cdn-cgi/challenge-platform', 'checking your browser', 'pardon our interruption', 'access denied', 'attention required']
def canonical(u):
    u = re.sub(r'^http:', 'https:', u)
    u = re.sub(r'^https:/{2}[a-z]{2,3}\.linkedin\.com', 'https://www.linkedin.com', u, flags=re.I)
    u = re.sub(r'^https:/{2}(?:www\.)?(?:twitter|x)\.com', 'https://x.com', u, flags=re.I)
    u = re.sub(r'^https:/{2}(?:web\.|m\.|[a-z]{2}-[a-z]{2}\.)facebook\.com', 'https://www.facebook.com', u, flags=re.I)
    u = re.sub(r'^https:/{2}(instagram|youtube|tiktok|facebook|linkedin)\.com', r'https://www.\1.com', u, flags=re.I)
    u = u.split('?')[0].split('#')[0]
    u = re.sub(r'/(jobs|about|posts|photos|videos|life|featured)/?$', '', u, flags=re.I)
    return u.rstrip('/')
def best(text, pat):
    counts, last = {}, {}
    for m in re.finditer(pat, text, re.I):
        k = canonical(m.group(0))
        if not re.search(r'linkedin|youtube\.com/channel', k, re.I):
            k = k.lower()  # handles on X, Facebook, Instagram, TikTok are case-insensitive
        counts[k] = counts.get(k, 0) + 1
        last[k] = m.start()
    if not counts: return '', 0, 0
    foot = len(text) * 0.8
    scored = sorted(((n + (2 if last[k] >= foot else 0), k) for k, n in counts.items()), reverse=True)
    return scored[0][1], len(counts), scored[0][0]
def handler(context):
    res = context.get('page') or {}
    items = res.get('results') if isinstance(res, dict) else None
    it = items[0] if isinstance(items, list) and items else {}
    crawl = it.get('crawl') or {}
    code = crawl.get('httpStatusCode')
    md = it.get('markdown') or ''
    low = md.lower()
    challenge = any(c in low[:3000] for c in CHALLENGE)
    if not md or (code and int(code) >= 400) or challenge or crawl.get('requestStatus') == 'failed':
        status = 'blocked' if (challenge or (code and int(code) in (401, 403, 429, 503))) else 'unreadable'
        out = {'page_status': status, 'http_status': str(code), 'bytes': len(md), 'candidates_seen': '{}'}
        for p in PAT: out[p] = ''
        return out
    out = {'page_status': 'read', 'http_status': str(code), 'bytes': len(md)}
    seen = {}
    for p, pat in PAT.items():
        u, n, sc = best(md, pat)
        out[p] = u
        seen[p] = n
    out['candidates_seen'] = json.dumps(seen)
    if len(md) < 5000 and not any(out[p] for p in PAT):
        out['page_status'] = 'thin'  # a script-rendered shell or a stripped page: a non-answer, not a clean miss
    return out
