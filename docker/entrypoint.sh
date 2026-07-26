#!/usr/bin/env bash
#
# Sunstone Web container entrypoint.
#
# Runs BOTH processes that make up the web deployment in one container:
#
#   1. sunstone-server — the Rust API over the Bundle. Writable iff
#      SUNSTONE_JWT_SECRET is set (the dex and wiki stacks set it; the two plain
#      stacks do not, so there every write route 401s).
#      (binds 0.0.0.0:${SUNSTONE_API_PORT}; the Bundle root is the server's to
#      resolve — ${SUNSTONE_BUNDLE} in the plain shape, /srv/repo/<subdir> in a
#      git shape.)
#   2. node build      — the SvelteKit adapter-node SSR server (binds
#      ${HOST}:${PORT}); its `/api/*` proxy + SSR loads reach the API at
#      ${SUNSTONE_API_INTERNAL} (http://localhost:${SUNSTONE_API_PORT}).
#
# The script is PID 1. It forwards SIGTERM/SIGINT to both children and, via
# `wait -n`, exits as soon as EITHER child dies — so a crash of the API or the
# web server tears the whole container down (and Docker/compose can restart it)
# instead of leaving a half-dead container serving errors.
#
# That is its WHOLE job. Bundle resolution, the optional seed copy
# (SUNSTONE_BUNDLE_SEED_FROM), `git init`/clone and the sync loop all belong to
# sunstone-server: in a git shape only the server knows the bundle root
# (/srv/repo/<subdir>), so a shell step reading SUNSTONE_BUNDLE would write to
# the wrong place. Do not reintroduce one here.

set -euo pipefail

API_PORT="${SUNSTONE_API_PORT:-8787}"
export SUNSTONE_API_PORT="${API_PORT}"
# The SSR server and its /api proxy always talk to the API on loopback inside
# the container; default it here so a bare `docker run` still wires up.
export SUNSTONE_API_INTERNAL="${SUNSTONE_API_INTERNAL:-http://localhost:${API_PORT}}"
export HOST="${HOST:-0.0.0.0}"
export PORT="${PORT:-3000}"

pids=()

term() {
  # Forward the stop signal to both children; ignore "already gone" errors.
  for pid in "${pids[@]}"; do
    kill -TERM "$pid" 2>/dev/null || true
  done
}
trap term TERM INT

echo "sunstone-web: starting API (sunstone-server) on :${API_PORT}, bundle=${SUNSTONE_BUNDLE:-<default>}"
sunstone-server &
pids+=("$!")

echo "sunstone-web: starting SSR web server (node build) on ${HOST}:${PORT}"
# `env -u SUNSTONE_GIT_SSH_KEY`: the deploy key is the Rust server's business
# alone. It reads the variable at boot and calls remove_var so no git or ssh
# child of *its own* inherits the material — but node is a SIBLING started by
# this script, so that removal cannot reach it. Without this, the
# internet-facing SSR process (and anything that dumps its environment on
# crash) would carry push credentials for the container's whole life, for a
# variable it never reads. This does not make the key secret — PID 1 still
# holds it and `docker inspect` still shows it — it closes the one copy that is
# both useless and exposed.
env -u SUNSTONE_GIT_SSH_KEY node build &
pids+=("$!")

# Block until either child exits, then bring the other down and propagate the
# exit code so the container stops (not restarts silently as a zombie).
set +e
wait -n
code=$?
set -e
echo "sunstone-web: a child process exited (code ${code}); shutting down the container"
term
wait
exit "$code"
