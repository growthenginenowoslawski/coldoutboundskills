#!/usr/bin/env python3
"""
Read a CSV with a research column, append a `Personalized Snippet` column with provided
snippet values, and write back. Uses csv.QUOTE_ALL so multi-line research cells survive
the round-trip without corruption.

Usage:
    python3 csv_writer.py --csv path/to/file.csv --snippets path/to/snippets.json \
        [--account-col "Account Name"] [--snippet-col "Personalized Snippet"]

snippets.json format: { "Account A": "Saw you...", "Account B": "Saw...", ... }
Keys must match exactly to values in --account-col. Unmatched keys are reported.
Rows whose account name is not in the snippets dict are left with their existing snippet
value (or empty if the column is new).
"""

import argparse
import csv
import json
import sys
from pathlib import Path


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--csv", required=True, help="Path to the CSV to update")
    ap.add_argument("--snippets", required=True, help="Path to snippets.json")
    ap.add_argument("--account-col", default="Account Name", help="Column name to match on (default: Account Name)")
    ap.add_argument("--snippet-col", default="Personalized Snippet", help="Column name to write (default: Personalized Snippet)")
    args = ap.parse_args()

    csv_path = Path(args.csv)
    snippets_path = Path(args.snippets)

    if not csv_path.exists():
        print(f"FATAL: CSV not found: {csv_path}", file=sys.stderr)
        return 2
    if not snippets_path.exists():
        print(f"FATAL: snippets file not found: {snippets_path}", file=sys.stderr)
        return 2

    snippets = json.loads(snippets_path.read_text(encoding="utf-8"))
    if not isinstance(snippets, dict):
        print("FATAL: snippets.json must be an object mapping account name -> snippet", file=sys.stderr)
        return 2

    # Read
    with csv_path.open("r", newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        fieldnames = list(reader.fieldnames or [])
        rows = list(reader)

    if args.account_col not in fieldnames:
        print(f"FATAL: column '{args.account_col}' not in CSV headers: {fieldnames}", file=sys.stderr)
        return 2

    if args.snippet_col not in fieldnames:
        fieldnames.append(args.snippet_col)

    # Update
    matched = []
    unmatched_in_snippets = set(snippets.keys())
    csv_account_names = set()
    for r in rows:
        name = r.get(args.account_col, "")
        csv_account_names.add(name)
        if name in snippets:
            r[args.snippet_col] = snippets[name]
            matched.append(name)
            unmatched_in_snippets.discard(name)
        else:
            if not r.get(args.snippet_col):
                r[args.snippet_col] = ""

    # Write back with QUOTE_ALL so multi-line research cells survive
    with csv_path.open("w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames, quoting=csv.QUOTE_ALL)
        writer.writeheader()
        writer.writerows(rows)

    report = {
        "rows_total": len(rows),
        "snippets_provided": len(snippets),
        "snippets_matched": len(matched),
        "snippets_unmatched": sorted(unmatched_in_snippets),
        "csv_path": str(csv_path),
        "snippet_column": args.snippet_col,
    }
    print(json.dumps(report, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
