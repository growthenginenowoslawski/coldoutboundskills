#!/usr/bin/env python3
"""Deterministic guard and reading-level gate for the specificity line. Stdlib only.

The agent writes each row's JSON answer (fits, anchor, offer_item, line) by following
SKILL.md. This script judges those answers mechanically. It never writes a line itself.

Input (JSON file or stdin):
  {"offer_block": "<the installer's locked offer block, verbatim>",
   "rows": [{"id", "company_name", "source_text", "fits", "anchor", "offer_item", "line",
             "attempt": 1}]}
  source_text = the company description the line was written from (the only evidence).
  attempt     = 1 for the first write, 2 for the single rewrite after a guard failure.

Output: the rows plus "fails" (list), "grade" (Flesch-Kincaid of the line) and "verdict",
one of five values resolved in this order:
  no_data   the row had under MIN_SOURCE_CHARS of source text; nothing may be written
  no_fit    fits == "no" and the line is empty (a real answer)
  send      guard passed and grade <= MAX_GRADE
  rewrite   attempt 1 failed; the agent gets exactly one rewrite
  blank     attempt 2 failed, or fits == "yes" with an empty line; never ship it

Usage:
  python3 scripts/line_guard.py batch.json > judged.json
  python3 scripts/line_guard.py --self-test
"""
import json
import re
import sys

MIN_WORDS, MAX_WORDS, MAX_CHARS = 6, 14, 90
MAX_GRADE = 7.0
MIN_SOURCE_CHARS = 150
BANNED = ["product margins", "channel", "gross margin", "across channels", "across platforms",
          "your business", "your products", "boost margins", "improve efficiency",
          "grow faster", "grow sales", "more sales", "drive demand", "increase sales",
          "platform"]
NAME_STOP = {"corp", "inc", "company", "group", "llc", "ltd", "the", "and"}
_FRAME_RE = re.compile(
    r"^\W*(?:specifically\s*,?\s*)?(?:i\s+think\s+)?(?:we\s+(?:can|could)\s+)?(?:help\s+you\s+)?",
    re.I)


def strip_frame(text):
    """Remove a frame fragment a rewrite glued back on ("help you see ..."). Without this
    the guard fails the rewrite on 'frame word repeated' and the row blanks."""
    t = (text or "").strip().strip('"').strip()
    prev = None
    while prev != t:
        prev = t
        t = _FRAME_RE.sub("", t, count=1).strip()
    return t.rstrip(".").strip()


def _syllables(word):
    w = re.sub(r"[^a-z]", "", word.lower())
    if not w:
        return 0
    n = len(re.findall(r"[aeiouy]+", w))
    if w.endswith("e") and n > 1 and not w.endswith(("le", "ee", "ye")):
        n -= 1
    return max(1, n)


def fk_grade(text):
    words = re.findall(r"[A-Za-z']+", text)
    if not words:
        return 0.0
    sents = max(1, len(re.findall(r"[.!?]", text)))
    syl = sum(_syllables(w) for w in words)
    return round(0.39 * (len(words) / sents) + 11.8 * (syl / len(words)) - 15.59, 1)


def guard(line, anchor, offer_item, source_text, company_name, offer_block):
    fails = []
    low, src = line.lower(), source_text.lower()
    if not anchor:
        fails.append("no anchor")
    else:
        word = anchor.lower().split()[-1]
        head = word
        if word.endswith("ies") and len(word) > 4:
            head = word[:-3] + "y"          # accessories -> accessory
        elif word.endswith("s") and not word.endswith("ss") and len(word) > 3:
            head = word[:-1]                # socks -> sock, glass stays glass
        if word not in src and head not in src:
            fails.append('anchor head "%s" not in source text' % head)
        if word not in low and head not in low:
            fails.append('anchor head "%s" not in line' % head)
    anchor_words = set(anchor.lower().replace("-", " ").split())
    for w in re.split(r"[\s,]+", company_name.lower()):
        w = w.strip(".")
        if len(w) > 3 and w not in anchor_words and w not in NAME_STOP and \
                re.search(r"\b%s" % re.escape(w), low):
            fails.append('company name word "%s" in line' % w)
    for b in BANNED:
        if b in low:
            fails.append('banned phrase "%s"' % b)
    if "—" in line or "–" in line:
        fails.append("em or en dash")
    first = line.split()[0]
    if first[0].isupper() and first.strip(".,") not in source_text \
            and first.lower() not in anchor.lower():
        fails.append("leading capital")
    if line.endswith("."):
        fails.append("trailing period")
    if "help you" in low or "specifically" in low:
        fails.append("frame word repeated")
    n = len(line.split())
    if n < MIN_WORDS or n > MAX_WORDS:
        fails.append("word count %d" % n)
    if len(line) > MAX_CHARS:
        fails.append("length %d over %d" % (len(line), MAX_CHARS))
    if not offer_item:
        fails.append("no offer_item")
    elif offer_item.lower() not in offer_block.lower():
        fails.append("offer_item not copied from the offer block")
    return fails


def judge(row, offer_block):
    out = dict(row)
    src = row.get("source_text") or ""
    line = strip_frame(row.get("line") or "")
    out["line"] = line
    fits = (row.get("fits") or "").strip().lower()
    attempt = int(row.get("attempt") or 1)
    out["fails"], out["grade"] = [], None
    if len(src.strip()) < MIN_SOURCE_CHARS:
        out["verdict"] = "no_data"
        if line:
            out["fails"] = ["line written without enough source text"]
    elif fits == "no" and not line:
        out["verdict"] = "no_fit"
    elif not line:
        out["fails"] = ["fits yes but empty line"]
        out["verdict"] = "blank"
    else:
        fails = guard(line, (row.get("anchor") or "").strip(),
                      (row.get("offer_item") or "").strip(), src,
                      row.get("company_name") or "", offer_block)
        g = fk_grade(line)
        out["grade"] = g
        if g > MAX_GRADE:
            fails.append("grade %.1f over %.1f" % (g, MAX_GRADE))
        out["fails"] = fails
        out["verdict"] = "send" if not fails else ("rewrite" if attempt == 1 else "blank")
    out["ship"] = line if out["verdict"] == "send" else ""
    return out


def self_test():
    offer = "- inventory and cost of goods sold tracking per product\n- cash flow forecasting"
    src = "Makes hard coolers and drinkware sold through dealers and online. " * 4
    cases = [
        ({"company_name": "Yeti", "source_text": src, "fits": "yes", "anchor": "hard cooler",
          "offer_item": "inventory and cost of goods sold tracking per product",
          "line": "see what each hard cooler really costs to build before you price it"}, "send"),
        ({"company_name": "Yeti", "source_text": src, "fits": "yes", "anchor": "hard cooler",
          "offer_item": "margin reporting by channel",
          "line": "see what each hard cooler really costs to build before you price it"}, "rewrite"),
        ({"company_name": "Yeti", "source_text": src, "fits": "yes", "anchor": "hard cooler",
          "offer_item": "cash flow forecasting",
          "line": "help you track product margins for every hard cooler you sell", "attempt": 2}, "blank"),
        ({"company_name": "City Parks", "source_text": src, "fits": "no", "anchor": "",
          "offer_item": "", "line": ""}, "no_fit"),
        ({"company_name": "Ghost", "source_text": "", "fits": "yes", "anchor": "x",
          "offer_item": "", "line": "see something"}, "no_data"),
    ]
    bad = 0
    for row, want in cases:
        got = judge(row, offer)["verdict"]
        if got != want:
            bad += 1
            print("FAIL want", want, "got", got, judge(row, offer)["fails"])
    print("self-test: %d/%d pass" % (len(cases) - bad, len(cases)))
    return bad


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "--self-test":
        sys.exit(1 if self_test() else 0)
    batch = json.load(open(sys.argv[1]) if len(sys.argv) > 1 else sys.stdin)
    json.dump([judge(r, batch["offer_block"]) for r in batch["rows"]], sys.stdout,
              ensure_ascii=False, indent=1)
    print()
