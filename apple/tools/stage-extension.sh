#!/bin/sh
# The appex pre-build phase (apple/project.yml, both ContextMintBridgeExtension
# targets): build the Safari extension from THIS tree, then stage its dist/
# into the appex's resources folder. All the rules — which folder, which names
# a flat iOS appex reserves, the Safari manifest checks, the version check
# against MARKETING_VERSION — are in stage-extension.ts beside this file and
# tested by tests/apple-stage-extension.test.ts; this only builds and says WHERE.
#
# Xcode passes its build settings as environment variables:
#   TARGET_BUILD_DIR + UNLOCALIZED_RESOURCES_FOLDER_PATH  the destination
#     (<appex>/Contents/Resources on macOS, the flat <appex> itself on iOS)
#   EXECUTABLE_NAME     the appex binary a flat bundle holds beside the resources
#   MARKETING_VERSION   the version manifest.json must carry
#   DERIVED_FILE_DIR    scratch space and the ledger of what was staged
#
# STAGE_EXTENSION_DIST, when set, is an already-built dist/ to stage as it is,
# with no npm build: for the tests, and for iterating on the Swift side
# without rebuilding the extension. Archives leave it unset.
set -eu

HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/../.." && pwd)

# Xcode runs a phase with a minimal PATH when it is launched from the Dock, so
# look where Homebrew and the usual installers put node before giving up.
if ! command -v node >/dev/null 2>&1; then
  PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
  export PATH
fi
if ! command -v node >/dev/null 2>&1; then
  echo "error: node is not on PATH — the Safari extension is built with npm (Node 26, see package.json)" >&2
  exit 1
fi

if [ -n "${STAGE_EXTENSION_DIST:-}" ]; then
  STAGE_DIST=$STAGE_EXTENSION_DIST
else
  (cd "$REPO" && npm run build --workspace=@fetchproxy/extension-safari) >&2
  STAGE_DIST="$REPO/packages/extension-safari/dist"
fi
export STAGE_DIST

exec node "$HERE/stage-extension.ts"
