#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT/apps/web"
[[ -f package.json ]] || { echo 'Copy customized Windows web frontend into apps/web first.' >&2; exit 2; }
command -v pnpm >/dev/null || { echo 'Install Node 22.12+ and pnpm' >&2; exit 2; }
pnpm install --frozen-lockfile
pnpm build
"$ROOT/scripts/install-web-dist.sh" "$ROOT/apps/web/dist"
