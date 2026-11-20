#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
command -v xcodegen >/dev/null || { echo 'Install XcodeGen: brew install xcodegen' >&2; exit 2; }

version=$(<"$ROOT/VERSION")
if [[ ! "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z]+([.-][0-9A-Za-z]+)*)?$ ]]; then
  echo 'VERSION must contain a release version such as 0.2.0-preview.3.' >&2
  exit 2
fi

printf 'MARKETING_VERSION = %s\nDEEPDESK_RELEASE_VERSION = %s\n' "${version%%-*}" "$version" \
  > "$ROOT/apps/macos/Config/Version.generated.xcconfig"
cd "$ROOT/apps/macos"
xcodegen generate --spec project.yml
