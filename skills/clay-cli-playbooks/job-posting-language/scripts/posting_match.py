# Posting matcher: paste into a Clay code node that follows an http-api-v2 node reading a
# public job board. Pure Python, no imports (the Clay code sandbox has no urllib).
# Inputs: board (pin the HTTP node at $.result), keywords (phrases joined by |),
#         title_words (role-family words joined by |; the posting TITLE must contain one),
#         window_days, today (YYYY-MM-DD).
# Reads the three public board shapes: Ashby {jobs:[...]}, Greenhouse {jobs:[...]} (?content=true),
# Lever [...]. Phrase-token matching on title + full description, newest first, deduped on title.

def strip_html(s):
    out, skip = '', False
    for ch in s or '':
        if ch == '<':
            skip = True
            out += ' '
        elif ch == '>':
            skip = False
        elif not skip:
            out += ch
    for a, b in (('&amp;', '&'), ('&nbsp;', ' '), ('&#39;', "'"), ('&quot;', '"'), ('&lt;', '<'), ('&gt;', '>')):
        out = out.replace(a, b)
    return out


def tokens(s):
    t, cur = [], ''
    for ch in (s or '').lower():
        if ch.isalnum():
            cur += ch
        else:
            if cur:
                t.append(cur)
            cur = ''
    if cur:
        t.append(cur)
    return t


def has_phrase(text_tokens, phrase):
    p = tokens(phrase)
    if not p:
        return False
    n = len(p)
    for i in range(len(text_tokens) - n + 1):
        if text_tokens[i:i + n] == p:
            return True
    return False


def day_number(iso):
    # days since 1970-01-01 for a YYYY-MM-DD prefix, no imports
    y, m, d = int(iso[0:4]), int(iso[5:7]), int(iso[8:10])
    if m <= 2:
        y -= 1
        m += 12
    return 365 * y + y // 4 - y // 100 + y // 400 + (153 * (m - 3) + 2) // 5 + d - 719469


def ms_to_iso(ms):
    days = int(ms) // 86400000
    # inverse of day_number via search (small loop, fine)
    y = 1970 + days // 366
    while day_number('%04d-12-31' % y) < days:
        y += 1
    for mo in range(1, 13):
        for dd in range(1, 32):
            try:
                if day_number('%04d-%02d-%02d' % (y, mo, dd)) == days:
                    return '%04d-%02d-%02d' % (y, mo, dd)
            except Exception:
                pass
    return ''


def normalise(board):
    # Accepts the three public board shapes: Ashby {jobs:[...]}, Greenhouse {jobs:[...]} with content, Lever [...]
    rows = board.get('jobs') if isinstance(board, dict) else board
    if isinstance(board, dict) and rows is None:
        rows = board.get('data') or board.get('postings') or []
    out = []
    for j in rows or []:
        if not isinstance(j, dict):
            continue
        title = (j.get('title') or j.get('text') or '').strip()
        url = j.get('jobUrl') or j.get('absolute_url') or j.get('hostedUrl') or ''
        date = j.get('publishedAt') or j.get('first_published') or j.get('updated_at') or ''
        if not date and j.get('createdAt'):
            date = ms_to_iso(j.get('createdAt'))
        desc = j.get('descriptionPlain') or strip_html(j.get('descriptionHtml') or j.get('content') or j.get('description') or '')
        for lst in j.get('lists') or []:
            desc += ' ' + strip_html(lst.get('content') or '')
        desc += ' ' + (j.get('additionalPlain') or '')
        out.append({'title': title, 'url': url, 'date': (date or '')[:10], 'desc': desc})
    return out


def handler(context):
    board = context.get('board') or {}
    phrases = [p.strip() for p in (context.get('keywords') or '').split('|') if p.strip()]
    families = [p.strip() for p in (context.get('title_words') or '').split('|') if p.strip()]
    window = int(context.get('window_days') or 0)
    today = (context.get('today') or '')[:10]
    postings = normalise(board)
    res = {'postings_read': len(postings), 'matched': 0, 'best_title': '', 'best_url': '', 'best_date': '',
           'best_phrase': '', 'other_titles': '', 'verdict': ''}
    if not postings:
        res['verdict'] = 'board_empty'
        return res
    if window <= 0 or not phrases:
        res['verdict'] = 'undeclared_window_or_keywords'
        return res
    hits, seen = [], set()
    for p in postings:
        if not p['date']:
            continue
        age = day_number(today) - day_number(p['date'])
        if age < 0 or age > window:
            continue
        if families and not any(has_phrase(tokens(p['title']), f) for f in families):
            continue
        tt = tokens(p['title'] + ' ' + p['desc'])
        ph = next((x for x in phrases if has_phrase(tt, x)), '')
        if not ph:
            continue
        key = p['title'].lower()
        if key in seen:
            continue
        seen.add(key)
        hits.append((p['date'], p, ph))
    hits.sort(key=lambda h: h[0], reverse=True)
    res['matched'] = len(hits)
    if not hits:
        res['verdict'] = 'no_match_in_window'
        return res
    d, p, ph = hits[0]
    res.update({'best_title': p['title'], 'best_url': p['url'], 'best_date': d, 'best_phrase': ph,
                'other_titles': ' | '.join(h[1]['title'] for h in hits[1:5]), 'verdict': 'matched'})
    return res
