# Funding eligibility: decides whether one funding-lookup payload may become a copy line.
# Pure Python, no imports, so it runs unchanged in the agent or in a Clay code node.
# Inputs: stage, round_date (YYYY-MM-DD), amount_usd, today (YYYY-MM-DD), window_months.
# Output: eligible_flag yes|no, stage_label, amount_label (rounded DOWN), months_ago, reason.

EQUITY = {
    'pre_seed', 'seed', 'angel', 'series_a', 'series_b', 'series_c', 'series_d', 'series_e',
    'series_f', 'series_g', 'series_h', 'series_i', 'series_j', 'series_unknown',
    'corporate_round', 'convertible_note', 'equity_crowdfunding', 'venture', 'venture_round',
}
# Labels a founder would not say about their own round: blanked so copy says "round".
BLANK = {'series_unknown', 'corporate_round', 'convertible_note', 'equity_crowdfunding', 'angel', 'venture', 'venture_round'}


def norm_stage(s):
    s = (s or '').strip().lower()
    out = ''
    for ch in s:
        out += ch if ch.isalnum() else '_'
    while '__' in out:
        out = out.replace('__', '_')
    return out.strip('_')


def label(stage_key):
    if stage_key in BLANK or not stage_key:
        return ''
    if stage_key.startswith('series_'):
        return 'Series ' + stage_key.split('_', 1)[1].upper()
    return stage_key.replace('_', '-').capitalize() if stage_key == 'pre_seed' else stage_key.capitalize()


def fmt_amount(a):
    try:
        n = float(str(a).replace(',', '').replace('$', ''))
    except Exception:
        return ''
    if n >= 1e9:
        v = int(n / 1e8) / 10.0
        t = ('%.1f' % v).rstrip('0').rstrip('.')
        return '$' + t + 'B'
    if n >= 1e6:
        return '$' + str(int(n / 1e6)) + 'M'
    if n >= 1e3:
        return '$' + str(int(n / 1e3)) + 'K'
    return ''


def months_between(date_s, today_s):
    y1, m1 = int(date_s[0:4]), int(date_s[5:7])
    y2, m2 = int(today_s[0:4]), int(today_s[5:7])
    return (y2 - y1) * 12 + (m2 - m1)


MISSING = {'', 'none', 'null', 'n_a', 'na', 'unknown', 'undisclosed_date'}


def handler(context):
    stage_key = norm_stage(context.get('stage'))
    if stage_key in MISSING:
        stage_key = ''
    date_s = (context.get('round_date') or '').strip()[:10]
    if date_s.lower() in MISSING:
        date_s = ''
    today_s = (context.get('today') or '').strip()[:10]
    window = int(context.get('window_months') or 0)
    res = {'eligible_flag': 'no', 'stage_label': '', 'amount_label': '', 'months_ago': -1, 'reason': ''}
    if not stage_key and not date_s:
        res['reason'] = 'no_round_on_record'
        return res
    if stage_key not in EQUITY:
        res['reason'] = 'excluded_stage:' + (stage_key or 'blank')
        return res
    ok_date = len(date_s) == 10 and date_s[4] == '-' and date_s[7] == '-' and date_s[:4].isdigit()
    if not ok_date:
        res['reason'] = 'undated'
        return res
    age = months_between(date_s, today_s)
    res['months_ago'] = age
    res['stage_label'] = label(stage_key)
    res['amount_label'] = fmt_amount(context.get('amount_usd'))
    if window <= 0:
        res['reason'] = 'no_window_declared'
        return res
    if age > window:
        res['reason'] = 'outside_window'
        return res
    res['eligible_flag'] = 'yes'
    res['reason'] = 'ok'
    return res


if __name__ == '__main__':
    # Agent usage: one JSON object per line on stdin, one JSON verdict per line on stdout.
    #   echo '{"domain":"x.com","stage":"Series B","round_date":"2026-05-01","amount_usd":52000000,
    #          "today":"2026-09-23","window_months":12}' | python3 scripts/funding_eligibility.py
    import json
    import sys
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        row = json.loads(line)
        out = handler(row)
        out['domain'] = row.get('domain', '')
        print(json.dumps(out))
