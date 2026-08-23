#!/bin/sh
cd -- "$(dirname -- "$0")" || exit 1
node scripts/activity-release-receipt.mjs activity-release-receipt.json
status=$?
if [ "${UE5_ACTIVITY_NO_PAUSE:-0}" != "1" ]; then
  printf '\nPress Return to close...'
  read -r _
fi
exit "$status"
