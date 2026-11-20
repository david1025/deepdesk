#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ "$(uname -s)" != 'Darwin' ]]; then
  echo "This command needs macOS and Xcode." >&2; exit 2
fi
command -v xcodegen >/dev/null || { echo "Install: brew install xcodegen" >&2; exit 2; }
command -v xcodebuild >/dev/null || { echo 'Install Xcode and command line tools' >&2; exit 2; }
"$ROOT/scripts/build-web.sh"
cd "$ROOT/apps/macos"
xcodegen generate --spec project.yml
xcodebuild -resolvePackageDependencies -project DeepSeekMac.xcodeproj -scheme DeepSeekMac
xcodebuild -project DeepSeekMac.xcodeproj -scheme DeepSeekMac \
  -configuration Debug -destination 'platform=macOS' CODE_SIGNING_ALLOWED=NO build
printf '\nBuilt unsigned Debug app. Open apps/macos/DeepSeekMac.xcodeproj in Xcode.\n'
