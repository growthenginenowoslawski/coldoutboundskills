#!/usr/bin/env python3
"""Screen colleague candidates for one target company, deterministically. No network, no model.

Runs AFTER the people search (one search per target domain) and the person-enrichment run on the
candidates' profile URLs. Everything that can be proven in code happens here, so the agent's
judgment step only ever sees candidates that are (a) not the recipient, (b) still at the target
company according to a fresh profile read, (c) not support staff, and (d) not a second index row
for a person already listed.

  --domain       the target company domain, bare and lowercase
  --search       JSON page(s) from `clay searches query-mode run` for that domain
  --enrich       JSON from `clay routines runs get` on the person-enrichment run (item ids "c<index>")
  --exclude-name one or more full names that must never be named (the recipient ALWAYS; others optional)
  --exclude-url  zero or more profile URLs that must never be named

Exits non-zero if --exclude-name is missing or empty: an empty exclusion set is not "nobody to
exclude", it is "nobody built the set".
"""
import argparse
import json
import sys
import unicodedata

SUPPORT = ["assistant", "administrator", "coordinator", "receptionist", "intern", "apprentice",
           "student", "product owner", "scrum", "office manager"]
# Seniority rank, most senior first; a title takes its most senior hit. Unranked titles sort last.
# "vice president" is removed from the title before "president" is looked for, so a VP never ranks
# as a president.
RANK = [("founder", 0), ("cofounder", 0), ("owner", 0), ("chief", 1), ("ceo", 1), ("coo", 1),
        ("cfo", 1), ("cto", 1), ("cio", 1), ("chro", 1), ("cco", 1), ("president", 2), ("partner", 2),
        ("svp", 3), ("evp", 3), ("vp", 3), ("head", 4), ("general manager", 5), ("director", 6),
        ("principal", 7)]


def fold(s):
    s = unicodedata.normalize("NFKD", s or "")
    s = "".join(c for c in s if not unicodedata.combining(c)).lower()
    return " ".join("".join(c if c.isalnum() or c.isspace() else " " for c in s).split())


def norm_url(u):
    u = (u or "").strip().lower().rstrip("/")
    for p in ("https://", "http://", "www."):
        if u.startswith(p):
            u = u[len(p):]
    return u


def rank(title):
    t = fold(title).replace("co founder", "cofounder")
    best = 9
    if "vice president" in t:
        best = 3
        t = t.replace("vice president", " ")
    words = t.split()
    for k, r in RANK:
        if (" " in k and k in t) or k in words:
            best = min(best, r)
    return best


def load_enrich(paths):
    """Items from `clay routines runs get`. That call pages results 20 at a time by default, so a run
    fetched without --limit 100 silently loses items. Refuse to continue when items are missing."""
    items, totals = {}, {}
    for p in paths:
        with open(p) as f:
            doc = json.load(f)
        rid = doc.get("routineRunId") or p
        totals[rid] = doc.get("total") or 0
        for item in doc.get("data") or []:
            res = item.get("result") or {}
            items[item.get("id")] = next(iter(res.values()), None) if res else None
            totals.setdefault(rid + "#seen", 0)
            totals[rid + "#seen"] += 1
    for rid, total in list(totals.items()):
        if rid.endswith("#seen"):
            continue
        seen = totals.get(rid + "#seen", 0)
        if seen < total:
            sys.exit(f"enrichment run {rid} has {total} items but only {seen} were read: re-fetch with "
                     f"`clay routines runs get <id> --limit 100` (or follow `cursor`) and pass every page")
    return items


def load(paths):
    out = []
    for p in paths:
        with open(p) as f:
            doc = json.load(f)
        for page in (doc if isinstance(doc, list) else [doc]):
            out.extend(page.get("data") or [])
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--domain", required=True)
    ap.add_argument("--search", nargs="+", required=True)
    ap.add_argument("--enrich", nargs="+", required=True)
    ap.add_argument("--exclude-name", nargs="*", default=[])
    ap.add_argument("--exclude-url", nargs="*", default=[])
    a = ap.parse_args()
    ex_names = {fold(n) for n in a.exclude_name if fold(n)}
    if not ex_names:
        sys.exit("refusing to run: --exclude-name is empty. The recipient's own name is mandatory.")
    ex_urls = {norm_url(u) for u in a.exclude_url if u}
    domain = a.domain.lower().removeprefix("www.")

    rows = load(a.search)
    enrich = load_enrich(a.enrich)

    out = []
    seen_names = set()
    for i, r in enumerate(rows):
        name = (r.get("name") or f"{r.get('first_name') or ''} {r.get('last_name') or ''}").strip()
        m = (r.get("matched_experiences") or [{}])[0]
        rec = {"row": i, "name": name, "search_title": m.get("title") or ""}
        if fold(name) in ex_names or (r.get("linkedin_url") and norm_url(r["linkedin_url"]) in ex_urls):
            rec["status"] = "excluded_recipient"
            out.append(rec)
            continue
        if fold(name) in seen_names:
            # The index can hold two profiles for one person (measured: same name, same site,
            # two rows). Naming them twice reads as a bug; keep the first.
            rec["status"] = "duplicate_person"
            out.append(rec)
            continue
        seen_names.add(fold(name))
        prof = enrich.get(f"c{i}")
        if not prof:
            rec["status"] = "unverified_no_profile"
            out.append(rec)
            continue
        here = [e for e in (prof.get("experience") or [])
                if e.get("is_current") and (e.get("company_domain") or "").lower().removeprefix("www.") == domain]
        if not here:
            rec["status"] = "not_current_at_target"
            rec["profile_current"] = [e.get("company") for e in (prof.get("experience") or []) if e.get("is_current")][:3]
            out.append(rec)
            continue
        title = here[0].get("title") or ""
        rec.update({
            "title_at_target": title,
            "headline": (prof.get("headline") or "")[:160],
            "first_name": (prof.get("first_name") or "").strip(),
            "last_name": (prof.get("last_name") or "").strip(),
            "other_current_roles": sum(1 for e in prof.get("experience") or [] if e.get("is_current")) - len(here),
            "seniority_rank": rank(title),
        })
        if any(k in fold(title) for k in SUPPORT):
            rec["status"] = "support_title"
        else:
            rec["status"] = "candidate"
        out.append(rec)
    out.sort(key=lambda x: (x["status"] != "candidate", x.get("seniority_rank", 9), x["row"]))
    json.dump(out, sys.stdout, indent=1, ensure_ascii=False)
    print()


if __name__ == "__main__":
    main()
