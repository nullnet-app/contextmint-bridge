#!/bin/sh
# Does this PR need the unsigned Apple build (ci.yml `apple`)? Reads the PR's
# changed file paths, one per line, on stdin and prints `true` or `false`.
#
# That build runs on the org's ONE shared self-hosted Mac, so it runs only for
# the paths that can change what it builds (plan Task 4): the container
# project, and the two extension packages its appex stages. Plus the job and
# this filter themselves, so a PR changing either one exercises it.
# Tested by tests/ci-apple-build.test.ts.
set -eu

result=false
while IFS= read -r path || [ -n "$path" ]; do
  case "$path" in
    apple/* | packages/extension-safari/* | packages/extension-core/* | \
      .github/workflows/ci.yml | .github/scripts/apple-build-paths.sh)
      result=true
      ;;
  esac
done
echo "$result"
