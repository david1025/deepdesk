#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOURCE="${1:-}"
TARGET="$ROOT/apps/macos/Resources/Web"
if [[ -z "$SOURCE" || ! -f "$SOURCE/index.html" ]]; then
  echo "Usage: $0 /absolute/path/to/dist (must contain index.html)" >&2
  exit 2
fi
SOURCE="$(cd "$SOURCE" && pwd)"
if [[ "$SOURCE" == "$TARGET" ]]; then echo "Source and target identical" >&2; exit 2; fi
# 先复制到临时目录，再原子替换；不要部分覆盖使旧 chunk 残留。
STAGING="$ROOT/apps/macos/Resources/Web.next.$$"
BACKUP="$ROOT/apps/macos/Resources/Web.prev.$$"
trap 'rm -rf "$STAGING"' EXIT
mkdir -p "$STAGING"
rsync -a --delete --exclude='.DS_Store' "$SOURCE/" "$STAGING/"
[[ -f "$STAGING/index.html" ]] || { echo 'Missing index.html' >&2; exit 3; }
if [[ -d "$TARGET" ]]; then mv "$TARGET" "$BACKUP"; fi
mv "$STAGING" "$TARGET"
rm -rf "$BACKUP"
echo "Installed web assets to $TARGET"
