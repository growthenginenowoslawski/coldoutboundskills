#!/usr/bin/env bash
# Build marketplace-ready ZIPs for every skill under skills/clay-cli-playbooks/.
#
# Usage: skills/clay-cli-playbooks/package.sh <path-to-clay-skill-creator-clone> [out-dir]
#   git clone https://github.com/sungwanjo-clay/clay-skill-creator   (Clay's official kit)
#
# Each skill is copied to a clean temp dir (no __pycache__), validated with the kit's own
# validator, and zipped only if it comes back with zero blocking findings.
set -euo pipefail

kit="${1:?usage: package.sh <clay-skill-creator dir> [out-dir]}"
here="$(cd "$(dirname "$0")" && pwd)"
out="${2:-$here/dist}"
tool="$kit/tools/package_skill.py"
[ -f "$tool" ] || { echo "not a clay-skill-creator clone: $kit" >&2; exit 2; }

mkdir -p "$out"
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
fail=0

for src in "$here"/*/; do
  [ -f "$src/SKILL.md" ] || continue
  slug="$(basename "$src")"
  cp -R "$src" "$tmp/$slug"
  find "$tmp/$slug" \( -name __pycache__ -o -name '*.pyc' \) -prune -exec rm -rf {} +
  if (cd "$kit" && python3 "$tool" validate "$tmp/$slug" > "$tmp/$slug.json"); then
    (cd "$kit" && python3 "$tool" zip "$tmp/$slug" "$out/$slug.zip" > /dev/null)
    echo "ok       $slug -> $out/$slug.zip"
  else
    echo "BLOCKED  $slug (see findings below)"; cat "$tmp/$slug.json"; fail=1
  fi
done

exit "$fail"
