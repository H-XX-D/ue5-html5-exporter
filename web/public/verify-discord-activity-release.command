#!/bin/sh
cd -- "$(dirname -- "$0")" || exit 1
node scripts/activity-release-receipt.mjs activity-release-receipt.json
status=$?
printf '\nPress Return to close...'
read -r _
exit "$status"
