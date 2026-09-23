#!/usr/bin/env python3
"""Derive the new-in-role fact pack deterministically. No network, no model, no Clay call.

Inputs (all local files the skill's earlier steps wrote):
  --search   JSON page(s) from `clay searches query-mode run` (a single page object, or a list of them)
  --enrich   JSON from `clay routines runs get` on the person-enrichment routine (one or more files)
  --window   the declared window in months (the same N used in the search query)
  --gate     comma-separated title keywords the CURRENT title must contain one of (include abbreviations)
  --today    YYYY-MM the run treats as "now" (default: the current UTC month)

Item ids in the enrichment run must be "p<index>" where index is the row's position in the
concatenated search pages, which is how Step 4 of the skill builds the run body.

Output: one JSON object per row on stdout (a list), with a single-valued `verdict` from a fixed set,
resolved in a stated order. The agent writes the copy line only for rows whose verdict is `ready`.
"""
import argparse
import datetime as dt
import json
import sys

VERDICTS = ["no_profile", "role_mismatch", "outside_window", "title_off_target", "ready"]
MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August",
          "September", "October", "November", "December"]


def ym(s):
    if not s or len(s) < 7:
        return None
    try:
        return int(s[0:4]), int(s[5:7])
    except ValueError:
        return None


def months_between(a, b):
    return (b[0] - a[0]) * 12 + (b[1] - a[1])


def norm(s):
    return " ".join((s or "").lower().replace(",", " ").split())


def load_pages(paths):
    rows = []
    for p in paths:
        with open(p) as f:
            doc = json.load(f)
        pages = doc if isinstance(doc, list) else [doc]
        for page in pages:
            rows.extend(page.get("data") or [])
    return rows


def load_enrich(paths):
    """`clay routines runs get` pages results 20 at a time by default, so a run fetched without
    --limit 100 silently loses items. Refuse to continue when a run's items are not all present."""
    out = {}
    for p in paths:
        with open(p) as f:
            doc = json.load(f)
        total, seen = doc.get("total") or 0, len(doc.get("data") or [])
        if seen < total:
            sys.exit(f"{p}: run has {total} items but this file holds {seen}. Re-fetch with "
                     f"`clay routines runs get <id> --limit 100` (or follow `cursor`).")
        for item in doc.get("data") or []:
            result = item.get("result") or {}
            # The result key's casing is not the routine's display name ("Enrich person" was
            # returned for a routine listed as "Enrich Person"), so take the single value.
            payload = next(iter(result.values()), None) if result else None
            out[item.get("id")] = payload if item.get("status") == "complete" else None
    return out


def same_employer(a, b):
    for k in ("org_id", "clay_company_id", "company_domain"):
        if a.get(k) and b.get(k) and a.get(k) == b.get(k):
            return True
    return bool(a.get("company")) and norm(a.get("company")) == norm(b.get("company"))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--search", nargs="+", required=True)
    ap.add_argument("--enrich", nargs="+", required=True)
    ap.add_argument("--window", type=int, required=True)
    ap.add_argument("--gate", required=True)
    ap.add_argument("--today")
    a = ap.parse_args()

    today = ym(a.today) if a.today else (dt.datetime.utcnow().year, dt.datetime.utcnow().month)
    gate = [g.strip().lower() for g in a.gate.split(",") if g.strip()]
    if not gate:
        sys.exit("--gate is empty: the title gate is mandatory, pass the keywords including abbreviations")

    rows = load_pages(a.search)
    enrich = load_enrich(a.enrich)
    out = []
    for i, row in enumerate(rows):
        m = (row.get("matched_experiences") or [{}])[0]
        rec = {
            "row": i,
            "first_name": row.get("first_name") or "",
            "search_title": m.get("title") or "",
            "search_company": m.get("company") or "",
            "search_start": m.get("start_date") or "",
        }
        prof = enrich.get(f"p{i}")
        exps = (prof or {}).get("experience") or []
        if not prof or not exps:
            rec["verdict"] = "no_profile"
            out.append(rec)
            continue
        current = [e for e in exps if e.get("is_current")]
        match = None
        for e in current:
            if norm(e.get("company")) == norm(rec["search_company"]) or norm(e.get("title")) == norm(rec["search_title"]):
                match = e
                break
        rec["current_roles_on_profile"] = len(current)
        if match is None:
            rec["verdict"] = "role_mismatch"
            rec["profile_current"] = [{"title": e.get("title"), "company": e.get("company")} for e in current][:3]
            out.append(rec)
            continue
        start = ym(match.get("start_date"))
        rec.update({
            "current_title": match.get("title") or "",
            "company_name": match.get("company") or "",
            "company_domain": match.get("company_domain") or "",
            "role_start": match.get("start_date") or "",
        })
        if not start:
            rec["verdict"] = "no_profile"
            rec["why"] = "profile has the role but no start month"
            out.append(rec)
            continue
        mir = months_between(start, today)
        rec["months_in_role"] = mir
        rec["role_start_month"] = f"{MONTHS[start[1] - 1]} {start[0]}"
        rec["start_year_is_current_year"] = start[0] == today[0]
        earlier = [e for e in exps if e is not match and not e.get("is_current")]
        earlier.sort(key=lambda e: e.get("start_date") or "", reverse=True)
        same = [e for e in earlier if same_employer(e, match)]
        if same:
            rec["role_change_type"] = "promotion"
            rec["prior_title"] = same[0].get("title") or ""
            rec["prior_company"] = same[0].get("company") or ""
        else:
            rec["role_change_type"] = "new_hire"
            rec["prior_title"] = earlier[0].get("title") if earlier else ""
            rec["prior_company"] = earlier[0].get("company") if earlier else ""
        if mir > a.window:
            rec["verdict"] = "outside_window"
        elif not any(g in (rec["current_title"] or "").lower() for g in gate):
            rec["verdict"] = "title_off_target"
        else:
            rec["verdict"] = "ready"
        out.append(rec)
    json.dump(out, sys.stdout, indent=1, ensure_ascii=False)
    print()


if __name__ == "__main__":
    main()
