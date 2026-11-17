#!/usr/bin/env bash
# Builds everything a deploy needs, from source: the admin UI's static export,
# placed where UiLayer expects it (ui/.layer/understory-ui/), then every
# function with `sam build --use-container`.
#
#   scripts/build.sh            then: cd app/aws && sam deploy --config-file ../../samconfig.<you>.yaml
#
# Docker must be running (see AGENTS.md: sharp needs a Linux arm64 build).
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"

echo "==> Building the admin UI"
# A clean install in CI; locally, the node_modules already there.
if [ -n "${CI:-}" ] || [ ! -d "$root/ui/node_modules" ]; then
  npm --prefix "$root/ui" ci --no-audit --no-fund
fi
npm --prefix "$root/ui" run build

# The export copies public/ in, and public/ is where `npm run config` puts a
# stack's config.json and branding. Neither belongs in a build every instance
# shares. (InstanceSetup skips them too; this keeps the layer honest.)
rm -rf "$root/ui/out/config.json" "$root/ui/out/branding"

rm -rf "$root/ui/.layer"
mkdir -p "$root/ui/.layer"
cp -R "$root/ui/out" "$root/ui/.layer/understory-ui"

echo "==> Building the functions"
cd "$root/app/aws"
sam build --use-container
