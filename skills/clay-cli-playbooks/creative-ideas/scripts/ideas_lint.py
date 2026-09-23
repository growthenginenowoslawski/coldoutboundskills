#!/usr/bin/env python3
"""Lint and gate the three creative-idea bullets for one or many rows.

Input: a JSON array of rows, each
  {"domain": "...", "evidence": "<the text the bullets were written from>",
   "bullet_1": "...", "bullet_2": "...", "bullet_3": "...",
   "evidence_1": "...", "evidence_2": "...", "evidence_3": "..."}
Output: the same rows with "qc" ("pass" or "fail"), "problems" (list) and "creative_ideas_block".

A row passes only when all three bullets are non-empty and every check holds. An empty bullet is
an honest abstain and fails the row into the non-ideas path; it is never padded.

Usage: python3 ideas_lint.py rows.json > rows.qc.json      (standard library only, no network)
"""
import json
import re
import sys

BANNED = ["leverage", "utilize", "streamline", "robust", "seamless", "empower", "synergy",
          "cutting-edge", "best-in-class"]


def norm(t):
    t = (t or "").lower()
    t = re.sub("[‘’“”]", "'", t)
    t = re.sub(r"[^a-z0-9%$&' ]+", " ", t)
    return re.sub(r"\s+", " ", t).strip()


def check(row):
    problems = []
    ev = norm(row.get("evidence", ""))
    bullets = [(row.get("bullet_%d" % i) or "").strip() for i in (1, 2, 3)]
    for i, b in enumerate(bullets, 1):
        e = (row.get("evidence_%d" % i) or "").strip()
        if not b:
            problems.append("bullet_%d empty (abstain)" % i)
            continue
        if not e or norm(e) not in ev:
            problems.append("evidence_%d is not a substring of the evidence text" % i)
        n = len(b.split())
        if n < 8 or n > 22:
            problems.append("bullet_%d has %d words, needs 8 to 22" % (i, n))
        if re.search("[—–]", b):
            problems.append("bullet_%d has an em or en dash" % i)
        if b.endswith("."):
            problems.append("bullet_%d ends with a period" % i)
        first = b.split()[0]
        if first[0].isupper() and not (len(first) > 1 and first[1:].lower() != first[1:]):
            problems.append("bullet_%d starts with a capital" % i)
        if re.match(r"^[-*•\d]", b):
            problems.append("bullet_%d starts with a bullet or number" % i)
        for w in BANNED:
            if re.search(r"\b%s\b" % re.escape(w), b, re.I):
                problems.append("bullet_%d uses banned word %s" % (i, w))
        if re.search(r"\ba [aeiou]", b, re.I):
            problems.append("bullet_%d has an 'a' before a vowel" % i)
    firsts = {b.split()[0].lower() for b in bullets if b}
    if len(firsts) > 1 and not firsts <= {"a", "an", "the"}:
        problems.append("bullets are not parallel (different opening word class)")
    row["problems"] = problems
    row["qc"] = "pass" if not problems else "fail"
    row["creative_ideas_block"] = "\n".join("- " + b for b in bullets) if not problems else ""
    return row


def main():
    rows = json.load(open(sys.argv[1], encoding="utf-8"))
    json.dump([check(r) for r in rows], sys.stdout, indent=1, ensure_ascii=False)
    print()


if __name__ == "__main__":
    main()
