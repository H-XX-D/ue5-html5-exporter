#!/bin/sh
script_directory=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd) || exit 1
exec "$script_directory/release-discord-activity.sh" --environment production --promote "$@"
