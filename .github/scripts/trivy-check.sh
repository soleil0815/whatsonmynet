#!/bin/sh
# Evaluates a Trivy JSON report of a release candidate (trivy-scan.sh: only HIGH/CRITICAL vulnerabilities that have a
# fix somewhere - unfixed ones never stop a release).
#   sh .github/scripts/trivy-check.sh <report.json>
#
# Time-limited exception: a fix that exists upstream does not reach the image at once (a new Node build of the base
# image, an npm package that has to follow first). A vulnerability made public less than GRACE_DAYS ago (default 14)
# therefore does not stop the release - it is listed as a warning with the date from which it blocks, and the daily
# scan of the published image (image-scan.yml) opens an issue for it. Older ones, ones without a date and secrets in
# the image always stop the release.
# (trivy-scan.sh runs the vulnerability scanner only; a secret check would need "--scanners vuln,secret" there -
# until then this script does not claim one.)
set -eu
f="$1"
grace="${GRACE_DAYS:-14}"
case "$grace" in '' | *[!0-9]*) echo "::error::GRACE_DAYS must be a number of days ($grace)"; exit 1 ;; esac
now="${TRIVY_NOW:-$(date -u +%s)}"
[ -s "$f" ] || { echo "::error::Trivy report $f is missing"; exit 1; }

# every finding with the time it was made public (0 = unknown: no exception)
# shellcheck disable=SC2016
rows='[.Results[]? | .Target as $t | .Vulnerabilities[]? | . + { target: $t,
  pub: ((.PublishedDate // "") | (try (sub("\\.[0-9]+"; "") | sub("[+-]00:00$"; "Z") | fromdateiso8601) catch 0)) }]'
limit=$((grace * 86400))
block="$(jq --argjson now "$now" --argjson lim "$limit" "$rows | map(select(.pub == 0 or (\$now - .pub) >= \$lim))" "$f")"
grace_list="$(jq --argjson now "$now" --argjson lim "$limit" "$rows | map(select(.pub > 0 and (\$now - .pub) < \$lim))" "$f")"
n="$(printf '%s' "$block" | jq length)"
g="$(printf '%s' "$grace_list" | jq length)"
s="$(jq '[.Results[]?.Secrets[]?] | length' "$f")"

printf '%s' "$block" | jq -r '.[] | "::error::\(.Severity) \(.VulnerabilityID) in \(.PkgName) \(.InstalledVersion) → \(.FixedVersion) (\(.target))"'
printf '%s' "$grace_list" | jq -r --argjson lim "$limit" '.[] | "::warning title=Exception until \((.pub + $lim) | strftime("%Y-%m-%d"))::\(.Severity) \(.VulnerabilityID) in \(.PkgName) \(.InstalledVersion) → \(.FixedVersion) (\(.target)) - made public \(.pub | strftime("%Y-%m-%d")), blocks releases from \((.pub + $lim) | strftime("%Y-%m-%d"))"'
jq -r '.Results[]? | .Target as $t | .Secrets[]? | "::error::Secret in image: \(.Severity) \(.RuleID)\(if .Title then " (\(.Title))" else "" end) in \($t)\(if .StartLine then ":\(.StartLine)" else "" end)"' "$f"

# the exceptions also go to the summary of the run, so they are seen without opening the log
if [ "$g" != 0 ] && [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  {
    echo "### Released with a time-limited exception ($(basename "$f"))"
    echo ""
    echo "Fixed upstream, but not in the image yet. Each one stops releases from the date shown on."
    echo ""
    echo "| Severity | ID | Package | Installed | Fixed in | Blocks from |"
    echo "|---|---|---|---|---|---|"
    printf '%s' "$grace_list" | jq -r --argjson lim "$limit" '.[] | "| \(.Severity) | \(.VulnerabilityID) | \(.PkgName) | \(.InstalledVersion) | \(.FixedVersion) | \((.pub + $lim) | strftime("%Y-%m-%d")) |"'
  } >> "$GITHUB_STEP_SUMMARY"
fi

fail=0
[ "$n" = 0 ] || { echo "$n fixable vulnerabilities (HIGH/CRITICAL) older than $grace days or without a date"; fail=1; }
[ "$s" = 0 ] || { echo "$s secrets found in the image"; fail=1; }
[ "$fail" = 0 ] || exit 1
if [ "$g" != 0 ]; then echo "$g fixable vulnerabilities newer than $grace days: released with a time-limited exception (see the warnings)."
else echo "No fixable HIGH/CRITICAL vulnerabilities."; fi
