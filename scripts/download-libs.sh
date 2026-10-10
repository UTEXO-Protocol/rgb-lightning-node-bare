#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' 'Unverified legacy downloads are disabled. Use npm run prepare-native with the pinned manifest.' >&2
exit 1
