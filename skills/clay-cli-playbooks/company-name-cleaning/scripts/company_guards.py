#!/usr/bin/env python3
"""Deterministic checks for company-name cleaning. Standard library only, no network, no key.

Two jobs, both free:

  risk   Before any cleaning: which raw strings the free formatter is known to get wrong,
         so the agent reads those rows itself instead of trusting a formatter output.
  check  After cleaning: which cleaned values must not ship (placeholder, invented text,
         format faults), whoever produced them.

Input:  a JSON list of rows {"id", "raw", "clean", "formatter"}. "clean" is the agent's
        answer ("" = abstain); "formatter" is the free formatter's output if the installer's
        table already has one (optional).
Output: the rows plus "risk" (list), "flags" (list), "verdict" and "ship".

Usage:
  python3 scripts/company_guards.py risk  rows.json   # before cleaning: route rows
  python3 scripts/company_guards.py check rows.json   # after cleaning: verdicts
  python3 scripts/company_guards.py --self-test
"""
import json
import re
import sys
import unicodedata

PLACEHOLDERS = {
    "na", "n", "none", "null", "nil", "unknown", "unknowncompany", "tbd", "tba", "test",
    "testing", "xxx", "asdf", "retired", "unemployed", "student", "freelance", "freelancer",
    "selfemployed", "self", "soleproprietor", "soleproprietorship", "privatepractice",
    "private", "confidential", "confidentialjobs", "confidentialcompany", "homemaker",
    "various", "other", "myself", "me", "personal", "notapplicable", "noneofyourbusiness",
    "stealth", "stealthmode", "stealthstartup",
}
# Legal suffixes the free formatter was measured to leave in place (", LP" on 2026-09-23),
# plus the long tail it was never tested on.
RARE_SUFFIX = re.compile(
    r"[,\s](lp|l\.p\.|llp|plc|pc|p\.c\.|pa|gmbh|ag|bv|nv|sa|sas|sarl|srl|spa|pty|ab|a/s|oy|kk|"
    r"sdn\s+bhd|private\s+limited|pvt\.?\s+ltd\.?)\.?\s*$", re.I)


def norm(s):
    s = unicodedata.normalize("NFKD", s or "")
    s = "".join(c for c in s if not unicodedata.combining(c))
    return re.sub(r"[^0-9a-z]", "", s.casefold())


def is_placeholder(v):
    n = norm(v)
    return (not n) or n in PLACEHOLDERS or n.startswith("selfemployed")


def risk(raw):
    """Why a free formatter should not be trusted on this row. Empty list = low risk."""
    r = []
    s = (raw or "").strip()
    if is_placeholder(s):
        r.append("placeholder")
    letters = re.sub(r"[^A-Za-z]", "", s)
    # The formatter's titleCase fires only when the WHOLE string is one case, and then it
    # flattens initialisms (EPC -> Epc, BPO -> Bpo) and splits brands (go2work -> Go 2 Work).
    if letters and letters.isupper():
        r.append("all_caps")
    if letters and letters.islower():
        r.append("all_lower")
    if re.search(r"[a-z][0-9]|[0-9][a-z]", s) or re.search(r"\b[a-z]+[A-Z]", s):
        r.append("brand_casing")
    if RARE_SUFFIX.search(s):
        r.append("rare_suffix")            # TRC Recreation, LP kept its suffix
    if re.search(r"[|:®™©]|\s[-–—]\s|\bd/?b/?a\b|doing business as", s, re.I):
        r.append("separator_or_mark")
    if re.search(r"[Ѐ-ӿ؀-ۿ֐-׿぀-ヿ一-鿿가-힯]", s):
        r.append("second_script")
    return r


def check(row):
    raw = row.get("raw") or ""
    clean = (row.get("clean") or "").strip()
    flags = []
    if clean and norm(clean) not in norm(raw):
        flags.append("invented_text")
    raw_words = {w.lower() for w in re.findall(r"[\w&'.-]+", raw)}
    for w in re.findall(r"[\w&'.-]+", clean):
        if w.lower() not in raw_words and w.lower().strip(".") not in raw_words:
            flags.append("token_not_in_input")
            break
    if clean and is_placeholder(clean):
        flags.append("placeholder_output")
    if re.search(r"[–—]", clean) or re.search(r"[.,\"'\s]$", clean):
        flags.append("format")
    if len(clean) > 60:
        flags.append("too_long")

    if "invented_text" in flags:
        verdict = "quarantine"
    elif not clean or is_placeholder(raw) or "placeholder_output" in flags:
        verdict = "abstain"
    elif flags or (row.get("confidence") or "high") == "low":
        verdict = "review"
    else:
        verdict = "send"
    out = dict(row)
    out["flags"] = flags
    out["verdict"] = verdict
    out["ship"] = clean if verdict == "send" else ""
    return out


SELF_TEST_RISK = [("EPC", "all_caps"), ("go2work", "brand_casing"),
                  ("TRC Recreation, LP", "rare_suffix"), ("Self-employed", "placeholder"),
                  ("Acme | Roofing and Siding", "separator_or_mark")]
SELF_TEST_CHECK = [
    ({"raw": "Hill Construction, LLC", "clean": "Hill Construction"}, "send"),
    ({"raw": "go2work", "clean": "Go 2 Work"}, "review"),
    ({"raw": "Self-employed", "clean": "Self-employed"}, "abstain"),
    ({"raw": "N/A", "clean": ""}, "abstain"),
    ({"raw": "Acme Roofing", "clean": "Acme Roofing and Siding"}, "quarantine"),
    ({"raw": "3Mcompany", "clean": "3M"}, "review"),
]


def self_test():
    bad = 0
    for raw, want in SELF_TEST_RISK:
        if want not in risk(raw):
            bad += 1
            print("FAIL risk", raw, risk(raw))
    for row, want in SELF_TEST_CHECK:
        got = check(row)["verdict"]
        if got != want:
            bad += 1
            print("FAIL check", row, "want", want, "got", got)
    total = len(SELF_TEST_RISK) + len(SELF_TEST_CHECK)
    print("self-test: %d/%d pass" % (total - bad, total))
    return bad


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "--self-test":
        sys.exit(1 if self_test() else 0)
    mode, path = sys.argv[1], (sys.argv[2] if len(sys.argv) > 2 else None)
    rows = json.load(open(path) if path else sys.stdin)
    if mode == "risk":
        rows = [dict(r, risk=risk(r.get("raw"))) for r in rows]
    else:
        rows = [check(r) for r in rows]
    json.dump(rows, sys.stdout, ensure_ascii=False, indent=1)
    print()
