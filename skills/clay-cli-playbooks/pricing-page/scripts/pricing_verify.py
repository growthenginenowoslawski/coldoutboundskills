#!/usr/bin/env python3
"""Mechanical claim check for pricing records: every plan name and every price must be on the page.

Input: a JSON array of records, each carrying "domain", "page_file" (path to the fetched page text)
and the record fields ("pricing_public", "pricing_model", "plans", "lowest_paid_price", ...).
Output: the same records with "verified" (bool) and "problems" (list). A record that fails is
downgraded: confidence becomes "low" and it may not be used for copy or for removing a row.

Usage: python3 pricing_verify.py records.json > records.verified.json   (standard library only)
"""
import json
import re
import sys


def norm(t):
    t = (t or "").lower().replace("\\", "")
    t = re.sub("[‘’“”]", "'", t)
    return re.sub(r"\s+", " ", t)


def amount(p):
    m = re.search(r"[\$£€]\s?\d[\d,]*(?:\.\d+)?", p or "")
    return m.group(0).replace(" ", "") if m else ""


def check(rec):
    problems = []
    page = norm(open(rec["page_file"], encoding="utf-8").read()) if rec.get("page_file") else ""
    flat = page.replace(",", "")
    for plan in rec.get("plans") or []:
        name = (plan.get("name") or "").strip()
        if name and norm(name) not in page:
            problems.append("plan name not on page: %s" % name)
        a = amount(plan.get("price", ""))
        if plan.get("price") and not a:
            problems.append("price has no currency amount: %s" % plan.get("price"))
        if a and a.replace(",", "") not in flat:
            problems.append("price not on page: %s" % a)
    low = amount(rec.get("lowest_paid_price", ""))
    if low and low.replace(",", "") not in flat:
        problems.append("lowest_paid_price not on page: %s" % low)
    if rec.get("pricing_public") and not any(amount(p.get("price", "")) for p in rec.get("plans") or []):
        problems.append("pricing_public true but no plan carries a currency amount")
    rec["verified"] = not problems
    rec["problems"] = problems
    if problems:
        rec["confidence"] = "low"
    return rec


def main():
    recs = json.load(open(sys.argv[1], encoding="utf-8"))
    json.dump([check(r) for r in recs], sys.stdout, indent=1, ensure_ascii=False)
    print()


if __name__ == "__main__":
    main()
