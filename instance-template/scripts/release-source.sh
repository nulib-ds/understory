# Shared by scripts/upgrade and scripts/verify: where releases come from, which
# is always understory-releases-<region>. UNDERSTORY_RELEASES only changes how it
# is read (https, or s3:// with credentials), never which bucket.

instance_region() {
  sed -nE 's/^[[:space:]]*region:[[:space:]]*([a-z0-9-]+).*/\1/p' "$root/samconfig.yaml" | head -n 1
}

release_base() {
  local region base
  region="$(instance_region)"
  if [[ -z "$region" ]]; then
    echo "No region in samconfig.yaml." >&2
    exit 1
  fi
  # Not ${UNDERSTORY_RELEASES:-…}: the braces in the default would end it.
  base='https://understory-releases-{region}.s3.{region}.amazonaws.com'
  if [[ -n "${UNDERSTORY_RELEASES:-}" ]]; then base="$UNDERSTORY_RELEASES"; fi
  echo "${base//\{region\}/$region}"
}

# fetch_release <version> <file> <destination>
fetch_release() {
  local url
  url="$(release_base)/v$1/$2"
  if [[ "$url" == s3://* ]]; then
    aws s3 cp --only-show-errors "$url" "$3"
  else
    curl -fsSL "$url" -o "$3"
  fi
}
