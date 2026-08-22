#!/bin/sh
cd -- "$(dirname -- "$0")" || exit 1
exec node scripts/activity-release-assistant.mjs "$@"
