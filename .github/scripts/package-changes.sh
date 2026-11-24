#!/bin/sh
# Security update: compares the package lists of the old and the new image of both architectures (package-diff.sh).
# Writes notes.md (the changes, for the release text) and prints "changed=true" or "changed=false" for $GITHUB_OUTPUT.
# Exit 1 when a comparison failed. Used by the jobs candidate-scan and publish (the same answer in both).
set -eu
: > notes.md
changed=false
for arch in amd64 arm64; do
  rc=0
  sh .github/scripts/package-diff.sh "old-$arch.txt" "new-$arch.txt" > "diff-$arch.md" || rc=$?
  case "$rc" in
    0) changed=true; { echo "### $arch"; cat "diff-$arch.md"; echo; } >> notes.md ;;
    3) ;;
    *) echo "::error title=Comparison failed::See the log of this step." >&2; exit 1 ;;
  esac
done
echo "changed=$changed"
