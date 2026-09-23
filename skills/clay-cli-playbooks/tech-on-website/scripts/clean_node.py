# Code-node body for the Clean node of the tech-on-website gate (see references/gate-workflow.md).
# Normalizes the domain and picks the technology's JSON oracle path. Pure Python, no network.
def handler(context):
    d = (context.get('domain') or '').strip().lower()
    for p in ('https://','http://'):
        if d.startswith(p): d = d[len(p):]
    if d.startswith('www.'): d = d[4:]
    d = d.split('/')[0].split('?')[0]
    t = (context.get('target_tech') or '').strip()
    oracles = {'shopify': '/products.json?limit=1', 'wordpress': '/wp-json/'}
    path = oracles.get(t.lower())
    return {'clean': d or 'invalid', 'home_url': 'https://' + (d or 'invalid.invalid') + '/', 'oracle_url': 'https://' + (d or 'invalid.invalid') + (path or '/'), 'has_oracle': 'yes' if path else 'no', 'target': t or 'unset'}

