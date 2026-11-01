#!/bin/bash
cd -- "$(dirname -- "$0")" || exit 1
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
if ! command -v node >/dev/null 2>&1; then echo '请先安装 Node.js 24.5.0 或更高版本。'; exit 1; fi
node scripts/mac-launcher.mjs install "$@"
