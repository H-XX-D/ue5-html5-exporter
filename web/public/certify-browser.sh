#!/bin/sh
set -eu
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$SCRIPT_DIR"
if command -v python3 >/dev/null 2>&1; then
  exec python3 serve.py --certify "$@"
fi
if command -v python >/dev/null 2>&1; then
  exec python serve.py --certify "$@"
fi
echo "Browser certification requires Python 3 or the one-click Unreal menu command." >&2
exit 1
