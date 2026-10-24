"""
seo_scrape_exa.py — deterministic website scrape via Exa /contents (stdlib only).

Decouples FETCH (cheap, deterministic, ~$0.002/site, zero Claude tokens) from
JUDGE (LLM). Pulls text + SEO-focused highlights for every row that still lacks a
result in .tmp/seo_results/, writes one page file per row to .tmp/seo_pages/.

A sub-agent then classifies from these local files — no live WebFetch, no per-site
WebSearch — so judging is ~5x cheaper than agents fetching each site themselves.
Rows Exa cannot crawl (status "empty") are the only ones needing WebSearch fallback.

Usage:
  python tools/seo_scrape_exa.py            # scrape all rows missing a result
  python tools/seo_scrape_exa.py --batches 35,36,38   # only these batch numbers

Re-run safe: skips rows already scraped (page file exists with status "ok").
"""

import argparse
import json
import os
import time
import urllib.request
import urllib.error

# Resolve against the working directory (where the skill is run), not the skill
# install location. Override with VALIDATE_COMPANY_WORKDIR.
HERE = os.environ.get("VALIDATE_COMPANY_WORKDIR", os.getcwd())
BATCH_DIR = os.path.join(HERE, ".tmp", "seo_batches")
RESULT_DIR = os.path.join(HERE, ".tmp", "seo_results")
PAGE_DIR = os.path.join(HERE, ".tmp", "seo_pages")
ENV_PATH = os.path.join(HERE, ".env")

EXA_URL = "https://api.exa.ai/contents"
EXA_BATCH = 10           # URLs per Exa call
EXA_SLEEP = 0.4          # seconds between calls
EXA_TIMEOUT = 45
MAX_CHARS = 4000         # text chars kept per site (enough to judge the criteria)
CRITERIA_PATH = os.path.join(HERE, ".tmp", "criteria.json")

# ── Validation criteria (generic) ────────────────────────────────────────────
# What counts as a "Yes" is NOT hardcoded. It is read from .tmp/criteria.json,
# which Claude writes after interviewing the user (target + keywords + Exa query
# + output column names). Falls back to an SEO/GEO default so the tool still runs
# stand-alone. See SKILL.md for the intake flow and criteria.json schema.
DEFAULT_QUERY = (
    "SEO référencement naturel payant GEO SEA SEM Google Ads search engine "
    "optimization marketing acquisition de trafic netlinking link building "
    "answer engine optimization AEO local SEO"
)
DEFAULT_KW = [
    ("référencement naturel", "Référencement naturel"),
    ("référencement payant", "Référencement payant"),
    ("référencement", "Référencement"),
    ("generative engine optim", "GEO"),
    ("answer engine optim", "AEO"),
    ("search engine optim", "SEO"),
    ("google ads", "Google Ads"),
    ("netlinking", "Netlinking"),
    ("link building", "Link building"),
    ("acquisition de trafic", "Acquisition de trafic"),
    (" seo", "SEO"),
    (" sea", "SEA"),
    (" geo", "GEO"),
]
DEFAULT_PATHS = ["/services", "/prestations", "/referencement", "/seo", "/expertises"]


def load_criteria():
    """Read .tmp/criteria.json → normalized criteria dict. SEO/GEO defaults if absent."""
    target = ""
    raw_kw, query, paths = None, None, None
    if os.path.exists(CRITERIA_PATH):
        c = json.load(open(CRITERIA_PATH, encoding="utf-8"))
        target = c.get("target", "")
        raw_kw = c.get("keywords")
        query = c.get("highlight_query")
        paths = c.get("service_paths")
    kw = []
    for item in (raw_kw or []):
        # accept "needle" or ["needle", "Label"]
        if isinstance(item, str):
            kw.append((item.lower(), item))
        elif isinstance(item, (list, tuple)) and item:
            needle = item[0]
            label = item[1] if len(item) > 1 else item[0]
            kw.append((needle.lower(), label))
    return {
        "target": target,
        "kw": kw or DEFAULT_KW,
        "query": query or DEFAULT_QUERY,
        "paths": paths or DEFAULT_PATHS,
    }


_CRIT = load_criteria()
KW = _CRIT["kw"]
HIGHLIGHT_QUERY = _CRIT["query"]
SERVICE_PATHS = _CRIT["paths"]


def load_key():
    # Prefer the environment variable; fall back to a .env file in the workdir.
    env = os.environ.get("EXA_API_KEY", "").strip()
    if env:
        return env
    if os.path.exists(ENV_PATH):
        for line in open(ENV_PATH, encoding="utf-8"):
            if line.startswith("EXA_API_KEY="):
                v = line.strip().split("=", 1)[1].strip()
                if v:
                    return v
    raise SystemExit("EXA_API_KEY not set (env var or .env). Exa steps need it; "
                     "the free fetch + keyword classify steps do not.")


def done_row_ids():
    """row_ids that already have a classification result."""
    ids = set()
    if not os.path.isdir(RESULT_DIR):
        return ids
    for fn in os.listdir(RESULT_DIR):
        if fn.endswith(".json"):
            try:
                for obj in json.load(open(os.path.join(RESULT_DIR, fn), encoding="utf-8")):
                    if obj.get("row_id") is not None:
                        ids.add(int(obj["row_id"]))
            except (json.JSONDecodeError, TypeError):
                pass
    return ids


def collect_rows(only_batches):
    """Rows from batch files that still need a result (optionally limited to batch nums)."""
    done = done_row_ids()
    rows = []
    for fn in sorted(os.listdir(BATCH_DIR)):
        if not fn.endswith(".json"):
            continue
        num = int(fn.replace("batch_", "").replace(".json", ""))
        if only_batches is not None and num not in only_batches:
            continue
        for r in json.load(open(os.path.join(BATCH_DIR, fn), encoding="utf-8")):
            if int(r["row_id"]) not in done:
                rows.append(r)
    return rows


def already_scraped(row_id):
    p = os.path.join(PAGE_DIR, f"row_{row_id}.json")
    if not os.path.exists(p):
        return False
    try:
        return json.load(open(p, encoding="utf-8")).get("status") == "ok"
    except json.JSONDecodeError:
        return False


def exa_contents(key, urls):
    body = json.dumps({
        "urls": urls,
        "text": {"maxCharacters": MAX_CHARS},
        "livecrawl": "fallback",
        "highlights": {"query": HIGHLIGHT_QUERY, "numSentences": 5},
    }).encode()
    req = urllib.request.Request(
        EXA_URL, data=body,
        headers={"x-api-key": key, "Content-Type": "application/json"},
    )
    resp = json.loads(urllib.request.urlopen(req, timeout=EXA_TIMEOUT).read())
    out = {}
    for res in resp.get("results", []):
        text = res.get("text") or ""
        hl = " ".join(res.get("highlights") or [])
        out[res.get("url")] = (text, hl)
    return out


# ── deterministic keyword classify (zero LLM tokens) ─────────────────────────
# KW / HIGHLIGHT_QUERY / SERVICE_PATHS are loaded from .tmp/criteria.json near the
# top of this file (see load_criteria). Nothing about the target is hardcoded here.


def cmd_classify_kw():
    """Keyword-classify every cached page that lacks a result. No LLM, no API."""
    done = done_row_ids()
    out = []
    scanned = ok_text = 0
    for fn in sorted(os.listdir(PAGE_DIR)):
        if not fn.endswith(".json"):
            continue
        o = json.load(open(os.path.join(PAGE_DIR, fn), encoding="utf-8"))
        if int(o["row_id"]) in done:
            continue
        scanned += 1
        blob = ((o.get("text") or "") + " " + (o.get("highlights") or "")).lower()
        if not blob.strip():
            # blocked / empty page — could not read site → Not Accessible
            out.append({
                "row_id": o["row_id"],
                "seo_services_found": "Not Accessible",
                "services_identified": "N/A",
            })
            continue
        ok_text += 1
        found = []
        for needle, label in KW:
            if needle in blob and label not in found:
                found.append(label)
        out.append({
            "row_id": o["row_id"],
            "seo_services_found": "Yes" if found else "No",
            "services_identified": ", ".join(found) if found else "None",
        })
    path = os.path.join(RESULT_DIR, "classify_kw.json")
    os.makedirs(RESULT_DIR, exist_ok=True)
    json.dump(out, open(path, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
    yes = sum(1 for r in out if r["seo_services_found"] == "Yes")
    no = sum(1 for r in out if r["seo_services_found"] == "No")
    na = sum(1 for r in out if r["seo_services_found"] == "Not Accessible")
    print(f"classify-kw: scanned {scanned} unclassified cached pages, "
          f"{ok_text} had text → {len(out)} classified "
          f"({yes} Yes / {no} No / {na} Not Accessible)")
    print(f"  wrote {path}")


def kw_scan(blob):
    blob = (blob or "").lower()
    found = []
    for needle, label in KW:
        if needle in blob and label not in found:
            found.append(label)
    return found


# Markers that mean the homepage is parked / placeholder / not a real site.
PARKED_MARKERS = [
    "index of /", "page par défaut", "page par defaut",
    "domain name has been registered", "site en construction",
    "en cours de construction", "coming soon", "under construction",
    "default web site page", "domain for sale", "achetez ce domaine",
    "ce domaine est à vendre", "parking",
]
# SERVICE_PATHS is loaded from criteria.json near the top of this file.


def cmd_multipage_no():
    """Exa multi-page pass over current 'No' rows: fetch service subpages,
    re-scan keywords (No→Yes), and flag parked homepages as Not Accessible.
    Writes classify_multipage.json — overrides classify_kw.json at merge
    (sorts after it, and load_results is last-wins by row_id)."""
    key = load_key()
    kw_path = os.path.join(RESULT_DIR, "classify_kw.json")
    results = json.load(open(kw_path, encoding="utf-8"))
    no_ids = {r["row_id"] for r in results if r["seo_services_found"] == "No"}
    pages = {}
    for fn in os.listdir(PAGE_DIR):
        if fn.endswith(".json"):
            o = json.load(open(os.path.join(PAGE_DIR, fn), encoding="utf-8"))
            pages[int(o["row_id"])] = o
    targets = [pages[i] for i in sorted(no_ids) if i in pages]
    print(f"multipage-no: {len(targets)} 'No' rows to re-check")

    out = {}
    to_fetch = []
    for o in targets:
        home = (o.get("text") or "").lower()
        if home and len(home) < 600 and any(m in home for m in PARKED_MARKERS):
            out[o["row_id"]] = {"row_id": o["row_id"],
                                "seo_services_found": "Not Accessible",
                                "services_identified": "N/A"}
            continue
        base = o["website"].rstrip("/")
        to_fetch.append((o["row_id"], [base + p for p in SERVICE_PATHS]))

    flat, url_row = [], {}
    for rid, urls in to_fetch:
        for u in urls:
            flat.append(u)
            url_row[u] = rid
    acc = {rid: "" for rid, _ in to_fetch}
    fetched = 0
    for i in range(0, len(flat), EXA_BATCH):
        chunk = flat[i:i + EXA_BATCH]
        try:
            got = exa_contents(key, chunk)
        except Exception as e:
            print(f"\n  batch @{i} err {e}")
            got = {}
        for u, (t, hl) in got.items():
            rid = url_row.get(u)
            if rid is not None:
                acc[rid] += " " + t + " " + hl
        fetched += len(chunk)
        print(f"  fetched {fetched}/{len(flat)} subpages", end="\r", flush=True)
        time.sleep(EXA_SLEEP)
    print()

    flips = 0
    for rid, blob in acc.items():
        found = kw_scan(blob)
        if found:
            out[rid] = {"row_id": rid, "seo_services_found": "Yes",
                        "services_identified": ", ".join(found)}
            flips += 1
        elif rid not in out:
            out[rid] = {"row_id": rid, "seo_services_found": "No",
                        "services_identified": "None"}
    path = os.path.join(RESULT_DIR, "classify_multipage.json")
    json.dump(list(out.values()), open(path, "w", encoding="utf-8"),
              ensure_ascii=False, indent=2)
    parked = sum(1 for v in out.values() if v["seo_services_found"] == "Not Accessible")
    print(f"multipage-no: {flips} No→Yes, {parked} No→Not Accessible "
          f"(of {len(targets)}) → {path}")


# ── free HTML-to-text fetch (stdlib only, zero API, zero tokens) ─────────────
import html as _html
import re as _re
import ssl as _ssl

_TAG = _re.compile(r"<[^>]+>")
_SCRIPT = _re.compile(r"<(script|style|noscript)[^>]*>.*?</\1>", _re.S | _re.I)
_WS = _re.compile(r"\s+")
_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "\
      "(KHTML, like Gecko) Chrome/120.0 Safari/537.36"


def html_to_text(raw):
    raw = _SCRIPT.sub(" ", raw)
    raw = _TAG.sub(" ", raw)
    return _WS.sub(" ", _html.unescape(raw)).strip()


def fetch_text(url):
    """Try https then http; return (text, status). Lenient TLS (self-signed)."""
    ctx = _ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = _ssl.CERT_NONE
    candidates = [url]
    if url.startswith("https://"):
        candidates.append("http://" + url[len("https://"):])
    for u in candidates:
        try:
            req = urllib.request.Request(u, headers={"User-Agent": _UA})
            raw = urllib.request.urlopen(req, timeout=20, context=ctx).read()
            enc = "utf-8"
            try:
                raw = raw.decode(enc, "replace")
            except Exception:
                raw = raw.decode("latin-1", "replace")
            txt = html_to_text(raw)[:MAX_CHARS]
            if txt:
                return txt, "ok"
        except Exception:
            continue
    return "", "blocked"


def cmd_fetch_free(only):
    """Free HTML-to-text fetch for rows still missing a result with no usable page."""
    done = done_row_ids()
    rows = collect_rows(only)
    os.makedirs(PAGE_DIR, exist_ok=True)
    todo = []
    for r in rows:
        if already_scraped(r["row_id"]):
            continue
        todo.append(r)
    print(f"fetch-free: {len(todo)} rows to try (stdlib urllib, no API, no tokens)")
    ok = blocked = 0
    for r in todo:
        txt, status = fetch_text(r["website"])
        if status == "ok":
            ok += 1
        else:
            blocked += 1
        json.dump({
            "row_id": r["row_id"], "company_name": r["company_name"],
            "website": r["website"], "status": status,
            "highlights": "", "text": txt,
        }, open(os.path.join(PAGE_DIR, f"row_{r['row_id']}.json"), "w",
                encoding="utf-8"), ensure_ascii=False, indent=2)
        print(f"  ok={ok} blocked={blocked}", end="\r", flush=True)
    print()
    print(f"fetch-free done: ok={ok} blocked={blocked}. Run --classify-kw next.")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--batches", help="comma-separated batch numbers, e.g. 35,36,38")
    ap.add_argument("--classify-kw", action="store_true",
                    help="keyword-classify cached pages lacking a result (zero tokens)")
    ap.add_argument("--fetch-free", action="store_true",
                    help="free stdlib HTML-to-text fetch for rows lacking a usable page")
    ap.add_argument("--multipage-no", action="store_true",
                    help="Exa multi-page re-check of current 'No' rows + parked detection")
    args = ap.parse_args()
    only = None
    if args.batches:
        only = {int(x) for x in args.batches.split(",") if x.strip() != ""}
    if args.fetch_free:
        cmd_fetch_free(only)
        return
    if args.multipage_no:
        cmd_multipage_no()
        return
    if args.classify_kw:
        cmd_classify_kw()
        return
    only = None
    if args.batches:
        only = {int(x) for x in args.batches.split(",") if x.strip() != ""}

    key = load_key()
    os.makedirs(PAGE_DIR, exist_ok=True)
    rows = collect_rows(only)
    todo = [r for r in rows if not already_scraped(r["row_id"])]
    print(f"scrape: {len(rows)} rows need results, {len(todo)} to fetch "
          f"({len(rows) - len(todo)} already scraped)")

    ok = empty = err = 0
    for i in range(0, len(todo), EXA_BATCH):
        chunk = todo[i:i + EXA_BATCH]
        urls = [r["website"] for r in chunk]
        try:
            got = exa_contents(key, urls)
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as e:
            print(f"  batch @{i} ERROR {type(e).__name__}: {e}")
            got = {}
            err += len(chunk)
        for r in chunk:
            text, hl = got.get(r["website"], ("", ""))
            status = "ok" if (text or hl) else "empty"
            if status == "ok":
                ok += 1
            elif r["website"] in got or not got:
                empty += 1
            json.dump({
                "row_id": r["row_id"],
                "company_name": r["company_name"],
                "website": r["website"],
                "status": status,
                "highlights": hl,
                "text": text,
            }, open(os.path.join(PAGE_DIR, f"row_{r['row_id']}.json"), "w",
                    encoding="utf-8"), ensure_ascii=False, indent=2)
        print(f"  [{min(i + EXA_BATCH, len(todo))}/{len(todo)}] ok={ok} empty={empty} err={err}", end="\r", flush=True)
        time.sleep(EXA_SLEEP)
    print()
    print(f"done: ok={ok} empty={empty} err={err} → {PAGE_DIR}")
    print("  'empty' rows need the WebSearch fallback path during classify.")


if __name__ == "__main__":
    main()
