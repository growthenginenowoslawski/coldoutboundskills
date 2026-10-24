#!/usr/bin/env python3
"""
Audit personalized cold email openers against the universal ruleset.

Usage:
    python3 audit.py --snippets snippets.json [--campaign-banned "ERP,Epicor,Kinetic"] [--max-words 40]

Input formats accepted:
- snippets.json: a dict { "Company A": "Saw you...", "Company B": "..." }
- snippets.json: a list [ {"name": "Company A", "snippet": "Saw..."}, ... ]
- snippets.txt: one snippet per line (no name attribution; failures show line numbers)

Exits 0 on pass, 1 on any failure.
Prints a JSON report to stdout with issues, distribution stats, and per-snippet word counts.
"""

import argparse
import json
import re
import sys
from pathlib import Path


UNIVERSAL_BANNED_WORDS = ["software", "workaround"]  # campaign-agnostic word-boundary banned words
UNIVERSAL_BANNED_PHRASES = [
    # Flattery / filler
    "hope this finds you well",
    "came across",
    "was impressed by",
    "positions you as",
    "Congratulations on",
    "It is clear that",
    "testament to",
    # Data-speak
    "the floor",
    "real-time view",
    "live data",
    "live view",
    "visibility into",
    "data room",
]
EMPATHY_PHRASES = ["I'm guessing", "I imagine", "I'd expect", "if it hasn't already"]


def load_snippets(path: Path):
    """Return list of (name_or_index, snippet) tuples."""
    text = path.read_text(encoding="utf-8")
    if path.suffix.lower() == ".json":
        data = json.loads(text)
        if isinstance(data, dict):
            return [(name, s) for name, s in data.items()]
        if isinstance(data, list):
            out = []
            for i, item in enumerate(data):
                if isinstance(item, dict):
                    out.append((item.get("name", f"#{i}"), item.get("snippet", "")))
                else:
                    out.append((f"#{i}", str(item)))
            return out
        raise ValueError("JSON must be object or array")
    # plain text — one per line
    return [(f"line {i+1}", line.strip()) for i, line in enumerate(text.splitlines()) if line.strip()]


def audit_one(name: str, snippet: str, campaign_banned: list, max_words: int):
    issues = []
    matched_phrases = []

    # Em / en dashes
    if "—" in snippet:
        issues.append("contains em dash (—)")
    if "–" in snippet:
        issues.append("contains en dash (–)")

    # Universal banned words (word boundary)
    for w in UNIVERSAL_BANNED_WORDS:
        if re.search(rf"\b{re.escape(w)}\b", snippet, re.IGNORECASE):
            issues.append(f"banned word '{w}' (universal)")

    # Campaign-specific banned words (word boundary; avoids false-positives like 'Caterpillar' containing 'erp')
    for w in campaign_banned:
        w = w.strip()
        if not w:
            continue
        if re.search(rf"\b{re.escape(w)}\b", snippet, re.IGNORECASE):
            issues.append(f"banned word '{w}' (campaign)")

    # Universal banned phrases (substring, case-insensitive)
    for p in UNIVERSAL_BANNED_PHRASES:
        if p.lower() in snippet.lower():
            issues.append(f"banned phrase '{p}'")

    # Empathy phrase required
    for p in EMPATHY_PHRASES:
        if p in snippet:
            matched_phrases.append(p)
    if not matched_phrases:
        issues.append("no empathy phrase (need one of: " + ", ".join(EMPATHY_PHRASES) + ")")

    # Length
    wc = len(snippet.split())
    if wc > max_words:
        issues.append(f"too long: {wc} words (max {max_words})")
    if wc < 10:
        issues.append(f"too short: {wc} words")

    return {"name": name, "word_count": wc, "issues": issues, "empathy_phrases": matched_phrases}


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--snippets", required=True, help="Path to snippets.json or snippets.txt")
    ap.add_argument("--campaign-banned", default="", help="Comma-separated campaign-specific banned words")
    ap.add_argument("--max-words", type=int, default=40, help="Hard word-count cap (default 40)")
    args = ap.parse_args()

    path = Path(args.snippets)
    if not path.exists():
        print(f"FATAL: snippets file not found: {path}", file=sys.stderr)
        return 2

    campaign_banned = [w for w in args.campaign_banned.split(",") if w.strip()]
    snippets = load_snippets(path)

    if not snippets:
        print("FATAL: no snippets found in input", file=sys.stderr)
        return 2

    results = [audit_one(name, s, campaign_banned, args.max_words) for name, s in snippets]
    failed = [r for r in results if r["issues"]]
    distribution = {p: 0 for p in EMPATHY_PHRASES}
    for r in results:
        for p in r["empathy_phrases"]:
            distribution[p] += 1

    word_counts = [r["word_count"] for r in results]
    report = {
        "total": len(results),
        "passed": len(results) - len(failed),
        "failed": len(failed),
        "empathy_distribution": distribution,
        "word_count": {
            "min": min(word_counts),
            "max": max(word_counts),
            "avg": round(sum(word_counts) / len(word_counts), 1),
        },
        "warnings": [],
        "failures": [{"name": r["name"], "issues": r["issues"]} for r in failed],
    }

    # Distribution warning: any phrase >60% of total
    if len(results) >= 5:
        for phrase, count in distribution.items():
            if count / len(results) > 0.6:
                report["warnings"].append(
                    f"empathy phrase '{phrase}' used in {count}/{len(results)} snippets — vary more"
                )

    print(json.dumps(report, indent=2))
    return 0 if not failed else 1


if __name__ == "__main__":
    sys.exit(main())
