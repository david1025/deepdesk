#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ "$(uname -s)" != 'Darwin' ]]; then
  echo "This command needs macOS and Xcode." >&2; exit 2
fi
command -v xcodebuild >/dev/null || { echo 'Install Xcode and command line tools' >&2; exit 2; }
"$ROOT/scripts/build-web.sh"
"$ROOT/scripts/generate-macos-project.sh"
cd "$ROOT/apps/macos"
xcodebuild -resolvePackageDependencies -project DeepSeekMac.xcodeproj -scheme DeepSeekMac
xcodebuild -project DeepSeekMac.xcodeproj -scheme DeepSeekMac \
  -configuration Debug -destination 'platform=macOS' \
  -derivedDataPath "$ROOT/artifacts/macos" CODE_SIGNING_ALLOWED=NO build
printf '\nBuilt unsigned Debug app: %s\n' "$ROOT/artifacts/macos/Build/Products/Debug/DeepSeek.app"
