#!/usr/bin/env bash
# Replaces nulib-ds/understory-template with this release's instance repo:
# instance-template/, plus the release's understory.yml and its checksum.
#
#   scripts/publish-template.sh <version> <release-dir> <template-checkout>
#
#   <release-dir>        holds understory.yml and understory.yml.sha256, for the
#                        region instance-template/samconfig.yaml names
#   <template-checkout>  a clone of understory-template that can push to origin
#
# release.yml runs this after every release (its template job). The template
# repo is a published copy and never edited by hand: instance-template/ here
# is the source. Its history is replaced by one commit, tagged v<version>,
# because a repo made from a template starts with no history anyway, so the
# template's own history would serve nobody.
set -euo pipefail

version="${1:?usage: scripts/publish-template.sh <version> <release-dir> <template-checkout>}"
release_dir="$(cd "${2:?release dir}" && pwd)"
checkout="$(cd "${3:?template checkout}" && pwd)"
root="$(cd "$(dirname "$0")/.." && pwd)"

if ! [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]]; then
  echo "$version is not a semantic version." >&2
  exit 1
fi
if ! (cd "$release_dir" && shasum -a 256 -c understory.yml.sha256 >/dev/null 2>&1); then
  echo "$release_dir/understory.yml does not match its checksum." >&2
  exit 1
fi
header="$(head -n 1 "$release_dir/understory.yml")"
if [[ "$header" != "# Understory v$version, packaged for "* ]]; then
  echo "$release_dir/understory.yml is not v$version: $header" >&2
  exit 1
fi
template_region="$(sed -nE 's/^[[:space:]]*region:[[:space:]]*([a-z0-9-]+).*/\1/p' "$root/instance-template/samconfig.yaml" | head -n 1)"
if [[ "$header" != *"packaged for $template_region." ]]; then
  echo "understory.yml is for another region than the template's ($template_region): $header" >&2
  exit 1
fi

cd "$checkout"
git checkout -q --orphan publish
git rm -rq --cached . >/dev/null 2>&1 || true
find . -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf {} +
cp -R "$root/instance-template/." .
cp "$release_dir/understory.yml" "$release_dir/understory.yml.sha256" .
git add -A
git commit -q -m "Understory v$version."
git branch -M main
git tag -f "v$version" >/dev/null
git push -q --force origin main "refs/tags/v$version"
echo "understory-template is now Understory v$version."
