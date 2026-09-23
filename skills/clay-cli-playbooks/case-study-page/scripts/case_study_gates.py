#!/usr/bin/env python3
"""Deterministic gates and line assembly for the case-study-page skill.

The agent reads the page and proposes ONE customer as JSON:
    {"client_name": "...", "evidence_quote": "...", "detail_phrase": "...", "confidence": "high|low"}
This script decides whether that proposal may ship, and builds the clause itself.
The model never writes the sentence.

Usage:
    python3 case_study_gates.py --domain northwind.example --page page.txt --pick pick.json
Prints one JSON object: {"case_study_line", "client_name", "detail_used", "verified", "ship_ready", "reject_reason", "notes"}

Standard library only. No network.
"""
import argparse
import json
import re
import sys

FINITE_VERB_RE = re.compile(
    r"\b(is|are|was|were|has|have|helps|helped|uses|used|centralis\w*|centraliz\w*|improves|improved|"
    r"delivers|delivered|gets|got|makes|made)\b", re.I)

PLACEHOLDER_NAMES = {
    "startup", "startups", "university", "universities", "company", "companies", "brand", "brands",
    "client", "clients", "customer", "customers", "partner", "partners", "logo", "logos", "enterprise",
    "agency", "business", "placeholder", "lorem ipsum", "acme", "acme corp", "acme inc", "your company",
    "company name", "example", "test", "demo", "nonprofit", "school", "schools", "hospital", "retailer",
    "bank", "team", "organization",
}

# Wording that means "this name is NOT the page owner's customer". The event/speaker terms were
# added after a live customers page opened with a keynote banner naming three speaker companies.
NON_CUSTOMER_CONTEXT = re.compile(
    r"\b(investors?|backed by|our backers|funded by|as seen in|as featured in|featured in|in the press|"
    r"press coverage|media coverage|newsroom|integrat(?:es|ion|ions) with|works with|our partners?|"
    r"partner (?:program|directory|network)|technology partners?|channel partners?|resellers?|awards?|"
    r"certified by|member of|powered by|built with|keynote|speakers?|hear from leaders|webinar|"
    r"join us|register now|save your seat)\b", re.I)

CUSTOMER_CONTEXT = re.compile(
    r"\b(customers?|case stud(?:y|ies)|success stor(?:y|ies)|customer stor(?:y|ies)|testimonials?|"
    r"clients?|our work|results|trusted by|read the story|read case study|"
    r"how .{0,40} (?:uses|used|grew|cut|saved|scaled))\b", re.I)

STOPWORDS = {"the", "and", "for", "with", "their", "this", "that", "from", "into", "your", "more",
             "than", "over", "across", "using", "about", "them"}
DANGLING = {"back", "up", "out", "on", "of", "to", "in", "off", "down", "again", "more", "less"}


def norm(t):
    t = t.lower()
    t = re.sub("[‘’“”]", "'", t)
    return re.sub(r"\s+", " ", t)


def loose(t):
    return re.sub(r"\s+", " ", re.sub(r"[^a-z0-9%$]+", " ", t, flags=re.I)).strip()


def non_customer_context(page, name):
    hay, needle = page.lower(), name.lower()
    idx, seen = hay.find(needle), False
    while idx >= 0:
        seen = True
        # The line holding the mention decides first. Measured 2026-09-23: a keynote banner naming
        # speaker companies sat 200 characters above "Hear from our customers", so the wide window
        # alone let an event speaker through as a customer.
        line_start = page.rfind("\n", 0, idx) + 1
        line_end = page.find("\n", idx)
        line = page[line_start: line_end if line_end >= 0 else len(page)]
        if NON_CUSTOMER_CONTEXT.search(line) and not CUSTOMER_CONTEXT.search(line):
            idx = hay.find(needle, idx + len(needle))
            continue
        win = page[max(0, idx - 600):idx] + " " + page[idx + len(needle): idx + len(needle) + 200]
        if not NON_CUSTOMER_CONTEXT.search(win) or CUSTOMER_CONTEXT.search(win):
            return False
        idx = hay.find(needle, idx + len(needle))
    return seen


def build_line(pick, page_text, domain):
    notes = []
    page = norm(page_text)
    name = (pick.get("client_name") or "").strip()
    quote = (pick.get("evidence_quote") or "").strip()
    detail = (pick.get("detail_phrase") or "").strip()
    conf = str(pick.get("confidence") or "").strip().lower()

    def reject(reason, note=None):
        if note:
            notes.append(note)
        return {"case_study_line": "", "client_name": "", "detail_used": "", "verified": False,
                "ship_ready": False, "reject_reason": reason, "notes": notes}

    if not name:
        return reject("abstain")
    if norm(name) not in page:                                    # gate 1
        return reject("name-not-on-page", "client_name not verbatim in page text")
    q = norm(quote)
    if not q or not (q in page or loose(q) in loose(page)):      # gate 2, full quote, never a prefix
        return reject("quote-not-on-page", "evidence_quote not verbatim in page text")
    if norm(name) not in q:                                       # gate 3
        return reject("quote-missing-name", "evidence_quote does not contain client_name")
    owner = domain.lower().split(".")[0]
    if owner and owner in re.sub(r"[^a-z0-9]", "", norm(name)):
        return reject("owner-as-customer", "client_name is the page owner")
    if re.sub(r"[^a-z0-9 ]", "", norm(name)).strip() in PLACEHOLDER_NAMES:   # gate 4
        return reject("placeholder-name", "client_name is a placeholder or generic noun")
    if non_customer_context(page_text, name):                     # gate 5
        return reject("non-customer-context", "name appears only in investor/press/partner/event wording")

    detail_used = ""
    if detail and conf != "high":
        notes.append("detail dropped: confidence is not high")
    elif detail:
        words = [w for w in re.split(r"[^a-z0-9%$]+", detail.lower()) if w and w not in STOPWORDS]
        tail = words[-1] if words else ""
        same = re.sub(r"[^a-z0-9]", "", norm(detail)) == re.sub(r"[^a-z0-9]", "", norm(name))
        ok = (not same and tail not in DANGLING and 0 < len(words) <= 5 and not FINITE_VERB_RE.search(detail)
              and not re.search(r"\b%s\b" % re.escape(owner), detail, re.I)
              and all((w[:5] if len(w) > 5 else w) in q and (w[:5] if len(w) > 5 else w) in page for w in words))
        if ok:
            detail_used = detail.rstrip(".,;:")
        else:
            notes.append("detail dropped: not grounded in evidence_quote")

    line = "your work with " + name + (" on " + detail_used if detail_used else "")
    if re.search("[—–]", line):
        return reject("em-dash")
    if len(line.split()) > 16:
        line, detail_used = "your work with " + name, ""
        notes.append("detail dropped: line over 16 words")
    return {"case_study_line": line, "client_name": name, "detail_used": detail_used, "verified": True,
            "ship_ready": conf == "high", "reject_reason": "", "notes": notes}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--domain", required=True)
    ap.add_argument("--page", required=True, help="file holding the fetched page text")
    ap.add_argument("--pick", required=True, help="file holding the agent's JSON pick")
    a = ap.parse_args()
    page = open(a.page, encoding="utf-8").read()
    pick = json.load(open(a.pick, encoding="utf-8"))
    json.dump(build_line(pick, page, a.domain), sys.stdout)
    print()


if __name__ == "__main__":
    main()
