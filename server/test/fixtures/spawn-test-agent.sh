#!/bin/sh
# Test double for a real `omp` binary. The server invokes it exactly like the
# real agent: `--mode rpc [--approval-mode …] --session <id> …`. bun cannot
# parse those flags, so this wrapper extracts just what the bundled mock RPC
# host understands (--session) and execs it cleanly.
session=""
prev=""
for arg in "$@"; do
	if [ "$prev" = "--session" ]; then
		session="$arg"
	fi
	prev="$arg"
done
exec bun "$(dirname "$0")/../../scripts/mock-rpc-host.ts" --session "$session"
