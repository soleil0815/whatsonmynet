#!/bin/sh
# Deletes the candidate images of one workflow run from the GitHub container registry.
# The release flows push <version>-kandidat-<run id>[-<arch>] before the checks; when the run ends (published,
# failed or cancelled) these package versions are no longer needed.
#
# Never deleted:
# - a version that carries any other tag as well (a real version tag such as 1.2.3 or 1.2.3-s1, latest, another
#   run's candidate) - after publishing, the checked candidate IS the published image, same digest;
# - a platform image that a published image (a version tagged with the version of this run or latest) points to -
#   the per-architecture candidates are the platform images of the published multi-arch image;
# - untagged versions (not ours to judge).
# If the published images cannot be read, nothing is deleted.
#
# Usage: sh .github/scripts/delete-candidates.sh <image> <run id>
#   image: ghcr.io/<owner>/<name> (or <owner>/<name>)
# Environment: GH_TOKEN (packages: write), PACKAGE_OWNER_TYPE=users|orgs (default users)
# Needs: gh, jq, docker buildx (reads the published image indexes).
set -euf

image="${1:?image}"
run="${2:?run id}"
case "$run" in '' | *[!0-9]*) echo "::error::Run id must be a number: $run" >&2; exit 2 ;; esac

ref="${image#ghcr.io/}"
owner="${ref%%/*}"
name="${ref#*/}"
if [ -z "$owner" ] || [ -z "$name" ] || [ "$owner" = "$ref" ]; then
  echo "::error::Image must be ghcr.io/<owner>/<name>: $image" >&2; exit 2
fi
case "${PACKAGE_OWNER_TYPE:-users}" in
  users | orgs) owner_type="${PACKAGE_OWNER_TYPE:-users}" ;;
  *) echo "::error::PACKAGE_OWNER_TYPE must be users or orgs" >&2; exit 2 ;;
esac
registry="ghcr.io/$owner/$name"
# A package name with a slash is one path segment in the API
enc_name="$(printf '%s' "$name" | sed 's#/#%2F#g')"
api="/$owner_type/$owner/packages/container/$enc_name/versions"

# 0 = tag is a candidate tag of this run: <version>-kandidat-<run> or <version>-kandidat-<run>-<arch>
is_candidate() {
  case "$1" in
    ?*-kandidat-"$run") return 0 ;;
    ?*-kandidat-"$run"-*)
      arch="${1##*-kandidat-"$run"-}"
      case "$arch" in '' | *[!a-z0-9]*) return 1 ;; *) return 0 ;; esac ;;
  esac
  return 1
}

# The version part of a candidate tag (1.2.3 of 1.2.3-kandidat-42-amd64)
version_of() { printf '%s\n' "${1%%-kandidat-*}"; }

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# One line per version: id <TAB> digest <TAB> tags (space separated)
gh api --paginate "$api?per_page=100" \
  --jq '.[] | [(.id | tostring), .name, ((.metadata.container.tags // []) | join(" "))] | join("\t")' > "$work/versions"

tab="$(printf '\t')"
: > "$work/delete"
: > "$work/keep"
: > "$work/release-tags"
while IFS="$tab" read -r id digest tags; do
  [ -n "$tags" ] || continue
  ours=0; other=''
  for t in $tags; do
    if is_candidate "$t"; then ours=1; version_of "$t" >> "$work/release-tags"; else other="$t"; fi
  done
  [ "$ours" = 1 ] || continue
  if [ -n "$other" ]; then
    echo "Kept $id ($tags): also tagged $other"
  else
    printf '%s\t%s\t%s\n' "$id" "$digest" "$tags" >> "$work/delete"
  fi
done < "$work/versions"

if [ ! -s "$work/delete" ]; then
  echo "No candidate images of run $run to delete."
  exit 0
fi

# Platform images the published images point to (version of this run, latest): never deleted
echo latest >> "$work/release-tags"
sort -u -o "$work/release-tags" "$work/release-tags"
: > "$work/protected"
while IFS="$tab" read -r id digest tags; do
  hit=0
  for t in $tags; do
    if grep -qxF -- "$t" "$work/release-tags"; then hit=1; fi
  done
  [ "$hit" = 1 ] || continue
  case "$digest" in sha256:*) ;; *) echo "::error::Unexpected digest of version $id: $digest - nothing deleted" >&2; exit 1 ;; esac
  if ! docker buildx imagetools inspect --raw "$registry@$digest" > "$work/manifest" 2> "$work/inspect.err"; then
    echo "::error::Cannot read $registry@$digest ($(cat "$work/inspect.err")) - nothing deleted" >&2; exit 1
  fi
  if ! jq -r '.manifests[]?.digest' "$work/manifest" >> "$work/protected"; then
    echo "::error::Cannot parse the index of $registry@$digest - nothing deleted" >&2; exit 1
  fi
done < "$work/versions"

failed=0
# Indexes (no architecture suffix) first, then the platform images
for pass in index platform; do
  while IFS="$tab" read -r id digest tags; do
    platform=1
    for t in $tags; do case "$t" in *-kandidat-"$run") platform=0 ;; esac; done
    if { [ "$pass" = index ] && [ "$platform" = 1 ]; } || { [ "$pass" = platform ] && [ "$platform" = 0 ]; }; then continue; fi
    if grep -qxF -- "$digest" "$work/protected"; then
      echo "Kept $id ($tags): platform image of a published image"
      continue
    fi
    if gh api -X DELETE "$api/$id" > /dev/null; then
      echo "Deleted $id ($tags)"
    else
      echo "::warning::Could not delete $id ($tags)"
      failed=1
    fi
  done < "$work/delete"
done
exit "$failed"
