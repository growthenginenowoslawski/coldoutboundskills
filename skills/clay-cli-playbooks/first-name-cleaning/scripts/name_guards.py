#!/usr/bin/env python3
"""Deterministic guards for first-name cleaning. Standard library only, no network, no key.

The agent writes `first_name_clean` for each row by following the rules in SKILL.md. This
script then checks every row mechanically, because the failures that ship a broken greeting
are the ones a writer (human or model) does not notice in its own output.

Input:  a JSON list of rows, each {"id", "first", "last", "company", "clean", "confidence"}.
        "clean" is the agent's answer ("" = abstain). "confidence" is "high" or "low".
Output: the same rows plus "flags" (list), "verdict" (one of five values) and "ship"
        (the value that may go into a greeting, "" when the row must not be sent).

Usage:
  python3 scripts/name_guards.py rows.json > checked.json
  python3 scripts/name_guards.py --self-test

The six guards (G1-G6) and why each exists are in SKILL.md, Step 6.
"""
import json
import re
import sys
import unicodedata

PLACEHOLDERS = {
    "na", "n", "none", "null", "nil", "nan", "unknown", "tbd", "tba", "test", "testing",
    "xxx", "asdf", "noname", "notprovided", "notapplicable", "nofirstname", "firstname",
    "admin", "administrator", "info", "information", "sales", "support", "team", "owner",
    "manager", "management", "hr", "office", "contact", "contactus", "help", "helpdesk",
    "service", "customerservice", "billing", "accounts", "accounting", "marketing",
    "webmaster", "postmaster", "noreply", "donotreply", "hello", "hi", "enquiries",
    "inquiries", "reception", "frontdesk", "general", "mail", "email", "user", "guest",
    "staff", "employee", "recruiting", "careers", "jobs", "press", "media", "legal",
}

# Latin letters (Basic Latin through Latin Extended-B, plus Latin Extended Additional),
# spaces, apostrophes, hyphens and dots. Anything else means the name is not writable in
# Latin script.
LATIN_RE = re.compile(r"^[ -ɏḀ-ỿ‘’ʼ'\-\.]*$")


def norm(s):
    """Casefold, strip accents, drop everything that is not a letter or digit."""
    s = unicodedata.normalize("NFKD", s or "")
    s = "".join(c for c in s if not unicodedata.combining(c))
    return re.sub(r"[^0-9a-z]", "", s.casefold())


def has_letters(s):
    """Unicode-aware emptiness test. norm() reduces a Chinese or Cyrillic name to "",
    so testing emptiness with norm() silently abstains on every non-Latin name."""
    return any(unicodedata.category(c).startswith("L") or c.isdigit() for c in (s or ""))


TITLES = {"dr", "mr", "mrs", "ms", "miss", "prof", "professor", "rev", "fr", "capt", "sir",
          "dame", "lord", "sr", "sra", "hr", "ing", "eng", "adv"}
TITLE_LEFT_RE = re.compile(r"^(%s)\.(?=\S)|^(%s)\s" % ("|".join(TITLES), "|".join(TITLES)), re.I)


def g1_placeholder(v):
    """Placeholder, mailbox role, no letters, a title on its own ("Dr.", "Prof.") or a single
    initial ("A", "O."). The last two are what a split-and-recase formatter returns when the
    field starts with a title or an initial (measured 2026-09-23)."""
    n = norm(v)
    return ((not has_letters(v)) or n in PLACEHOLDERS or n in TITLES
            or (len(n) == 1 and n.isalpha()))


def title_left(clean):
    """A title still glued to the name: "Dr.kavya", "Prof. Nora"."""
    return bool(TITLE_LEFT_RE.match(clean or ""))


def g2_company_overlap(first, last, company):
    fl, co = norm(first) + norm(last), norm(company)
    if len(fl) < 4 or len(co) < 3:
        return False
    return fl == co or co in fl or fl in co


def g3_caps_acronym(first):
    t = (first or "").strip()
    return bool(re.fullmatch(r"[A-Z0-9]{2,4}", t)) and not re.search(r"[AEIOUY]", t)


def g4_run_together(first):
    return bool(re.fullmatch(r"[A-Z]{9,}", (first or "").strip()))


def g5_non_latin(clean):
    return bool(clean) and not LATIN_RE.match(clean)


def g6_invented(first, clean):
    return bool(clean) and norm(clean) not in norm(first)


def check(row):
    first = row.get("first") or ""
    last = row.get("last") or ""
    company = row.get("company") or ""
    clean = (row.get("clean") or "").strip()
    flags = []
    if g6_invented(first, clean):
        flags.append("G6_invented_letters")
    if g1_placeholder(first) or (clean and g1_placeholder(clean)):
        flags.append("G1_placeholder")
    if g2_company_overlap(first, last, company):
        flags.append("G2_company_overlap")
    if g3_caps_acronym(first):
        flags.append("G3_caps_acronym")
    if g4_run_together(first):
        flags.append("G4_run_together")
    if g5_non_latin(clean):
        flags.append("G5_non_latin")
    if title_left(clean):
        flags.append("title_left")
    initials = re.fullmatch(r"(?:[A-Z]\.){2,3}", clean)       # J.D., K.C. stay as written
    if re.search(r"[–—]", clean) or (re.search(r"[.,\"\s]$", clean) and not initials):
        flags.append("format")

    # Five verdicts, first match wins.
    if "G6_invented_letters" in flags:
        verdict = "quarantine"
    elif not clean or "G1_placeholder" in flags:
        verdict = "abstain"
    elif "G5_non_latin" in flags:
        verdict = "non_latin"
    elif flags or (row.get("confidence") or "high") == "low":
        verdict = "review"
    else:
        verdict = "send"
    out = dict(row)
    out["flags"] = flags
    out["verdict"] = verdict
    out["ship"] = clean if verdict == "send" else ""
    return out


SELF_TEST = [
    ({"first": "Dr Ruba", "last": "Maatouk", "company": "Metro Dental", "clean": "Ruba"}, "send"),
    ({"first": "Admin", "last": "Egree", "company": "e-gree", "clean": ""}, "abstain"),
    ({"first": "Admin", "last": "Egree", "company": "e-gree", "clean": "Admin"}, "abstain"),
    ({"first": "TVK", "last": "Rao", "company": "", "clean": "Tvk"}, "review"),
    ({"first": "KIRKDELANEY", "last": "", "company": "", "clean": "Kirkdelaney"}, "review"),
    ({"first": "珊", "last": "苏", "company": "Axine", "clean": "珊"}, "non_latin"),
    ({"first": "Jon", "last": "Smith", "company": "", "clean": "John"}, "quarantine"),
    ({"first": "Jana", "last": "Meerman", "company": "Jana Meerman", "clean": "Jana"}, "review"),
    ({"first": "PAUL", "last": "Harlin", "company": "", "clean": "Paul"}, "send"),
    ({"first": "Kari", "last": "Olsen", "company": "", "clean": "Kári"}, "send"),
    ({"first": "Prof. Nora", "last": "Vale", "company": "", "clean": "Prof."}, "abstain"),
    ({"first": "Dr.Kavya", "last": "Rao", "company": "", "clean": "Dr.kavya"}, "review"),
    ({"first": "A", "last": "F", "company": "", "clean": "A"}, "abstain"),
    ({"first": "Drew", "last": "Barry", "company": "", "clean": "Drew"}, "send"),
    ({"first": "J.D.", "last": "Dougherty", "company": "", "clean": "J.D."}, "send"),
    ({"first": "\U0001F44B James", "last": "S.", "company": "", "clean": "\U0001F44B"}, "abstain"),
]


def self_test():
    bad = 0
    for row, want in SELF_TEST:
        got = check(row)["verdict"]
        if got != want:
            bad += 1
            print("FAIL", row, "want", want, "got", got)
    print("self-test: %d/%d pass" % (len(SELF_TEST) - bad, len(SELF_TEST)))
    return bad


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "--self-test":
        sys.exit(1 if self_test() else 0)
    rows = json.load(open(sys.argv[1]) if len(sys.argv) > 1 else sys.stdin)
    json.dump([check(r) for r in rows], sys.stdout, ensure_ascii=False, indent=1)
    print()
