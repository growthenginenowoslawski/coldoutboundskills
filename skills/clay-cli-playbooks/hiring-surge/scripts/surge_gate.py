# Department surge gate: reads ONE saved Clay people-search page (current employees of one
# company whose title matches one department's words) and decides the department's verdict.
# Pure Python, no imports beyond json/sys for the command line. Arithmetic only; no model.
#
# Usage:
#   python3 scripts/surge_gate.py <saved_search.json> <company name> <cutoff YYYY-MM> \
#       [--exclude "trainer,ai training"] [--min-starts 2] [--min-team 4] [--min-growth-pct 15] \
#       [--override-starts 6]
# --exclude drops people whose matched current title contains any of the phrases (whole words,
# case-insensitive) before counting, so a reviewed exclusion costs no second search.
#
# The thresholds are the author's, borrowed from a production rule benched on 20 held-out
# companies (17/20 with the floors, 10/20 without). The installer may change every one.
import json
import sys


def words(s):
    out, cur = [], ''
    for ch in (s or '').lower():
        if ch.isalnum():
            cur += ch
        elif cur:
            out.append(cur)
            cur = ''
    if cur:
        out.append(cur)
    return out


def has_phrase(title, phrase):
    t, p = words(title), words(phrase)
    return bool(p) and any(t[i:i + len(p)] == p for i in range(len(t) - len(p) + 1))


def verdict(page, company, cutoff, min_starts=2, min_team=4, min_growth_pct=15.0, override_starts=6,
            exclude=()):
    people = page.get('data') or []
    excluded = 0
    capped = bool(page.get('hasMore'))
    target = (company or '').strip().lower()
    team = starts = internal = undated = 0
    for p in people:
        exps = [e for e in (p.get('matched_experiences') or [])
                if (e.get('company') or '').strip().lower() == target]
        current = [e for e in exps if not e.get('end_date')]
        if not current:
            continue
        if any(has_phrase(e.get('title'), x) for e in current for x in exclude):
            excluded += 1
            continue
        team += 1
        start = max((e.get('start_date') or '') for e in current)
        if len(start) != 7:          # '' or a bare year: cannot place it in a month window
            undated += 1
            continue
        if start >= cutoff:
            starts += 1
            earlier = [e for e in exps if (e.get('start_date') or '') and (e.get('start_date') or '') < start]
            if earlier:
                internal += 1
    out = {'team': team, 'role_starts': starts, 'internal_moves_seen': internal,
           'undated': undated, 'excluded_by_title': excluded, 'capped': capped, 'growth_pct': None, 'verdict': ''}
    if not people or team == 0:
        out['verdict'] = 'no_department_found'
        return out
    if capped:
        out['verdict'] = 'lower_bound_only'
        return out
    base = team - starts
    if base > 0:
        out['growth_pct'] = round(100.0 * starts / base, 1)
    if starts < min_starts or team < min_team:
        out['verdict'] = 'below_floor'
        return out
    grew = base == 0 or out['growth_pct'] > min_growth_pct or starts > override_starts
    out['verdict'] = 'surge' if grew else 'steady'
    return out


if __name__ == '__main__':
    a = sys.argv[1:]
    page = json.load(open(a[0]))
    opts = {'exclude': ()}
    i = 3
    while i < len(a):
        k, v = a[i].lstrip('-').replace('-', '_'), a[i + 1]
        opts[k] = tuple(x.strip() for x in v.split(',') if x.strip()) if k == 'exclude' else float(v)
        i += 2
    print(json.dumps(verdict(page, a[1], a[2], **opts)))
