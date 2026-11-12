#!/bin/sh
# Resolve resources inside this installed app; never depend on a developer's PATH.
RECDOCK_HOST_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec "$RECDOCK_HOST_DIR/../../runtime/node" "$RECDOCK_HOST_DIR/native-host.cjs" "$@"
