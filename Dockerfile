# syntax=docker/dockerfile:1
#
# Sunstone Web — single-image, multi-stage build.
#
# The image bundles TWO server processes (see docker/entrypoint.sh):
#   - sunstone-server : the read-only Rust API (axum) over sunstone-core.
#   - node build      : the SvelteKit adapter-node SSR web server.
#
# This is the WEB deployment only. The Tauri desktop app (src-tauri) is NOT
# built or shipped here — src-tauri sources are copied into the Rust stage only
# because it is a Cargo *workspace member* (its manifest must be present to
# resolve the workspace), but nothing in it is compiled: we build just the
# `sunstone-server` package.

# ---------------------------------------------------------------------------
# Stage 1 — Rust API: compile sunstone-server in release mode.
# bookworm base so the resulting glibc matches the node:*-bookworm-slim runtime.
# ---------------------------------------------------------------------------
FROM rust:1-bookworm AS rust-build
WORKDIR /app

# Workspace manifests + lockfile first (with the crate sources) so the build
# resolves the pinned dependency graph. src-tauri is copied for workspace
# resolution only; `-p sunstone-server` never compiles it.
COPY Cargo.toml Cargo.lock ./
COPY crates ./crates
COPY src-tauri/Cargo.toml ./src-tauri/Cargo.toml

# A workspace member must have its declared source roots present to parse, even
# when it is not the package being built. src-tauri declares a [lib]
# (src/lib.rs), a default bin (src/main.rs) and a build script (build.rs);
# provide empty stubs so Cargo can load the workspace without compiling the real
# Tauri app or downloading its (tauri*) dependencies.
RUN mkdir -p src-tauri/src \
 && : > src-tauri/src/lib.rs \
 && echo 'fn main() {}' > src-tauri/src/main.rs \
 && echo 'fn main() {}' > src-tauri/build.rs

# Build only the server package. Cache the cargo registry and target dir across
# builds; copy the finished binary OUT of the (non-persisted) cache mount.
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/app/target \
    cargo build --release -p sunstone-server \
 && cp target/release/sunstone-server /usr/local/bin/sunstone-server

# Browser wasm module: the frontend's `vite build` imports the wasm-pack
# `--target web` output at `$lib/wasm/pkg` as a hard dependency (ADR 0006 §1),
# so it MUST exist before the web-build stage runs. Build it HERE — this stage
# already has the Rust toolchain and the workspace crate sources — and hand the
# `pkg/` to the web stage via COPY. `--out-dir` is absolute so it lands OUTSIDE
# the (non-persisted) /app/target cache mount and survives the layer.
RUN rustup target add wasm32-unknown-unknown
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    cargo install wasm-pack --locked --version 0.15.0
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/app/target \
    wasm-pack build crates/sunstone-wasm --target web --out-dir /app/wasm-pkg

# ---------------------------------------------------------------------------
# Stage 2 — Frontend: build the SvelteKit adapter-node output.
#
# Base on the real Node image (matching the runtime's node:22-bookworm) and add
# bun purely as the fast package manager. `bun run build` shells out to vite,
# whose `#!/usr/bin/env node` shebang must resolve to REAL Node: under bun's own
# runtime (oven/bun ships a `node` shim) the `vite-plugin-top-level-await`
# config-load path throws `virtualModule.require is not a function`. Real Node
# runs vite exactly as it does on a dev host, so the build matches local.
# ---------------------------------------------------------------------------
FROM node:22-bookworm AS web-build
WORKDIR /app

# bun is a single self-contained binary; copy it from the official image.
COPY --from=oven/bun:1 /usr/local/bin/bun /usr/local/bin/bun

# Install ALL deps (build needs vite/svelte-kit/adapters). The patch in
# patches/ is applied by bun during install, so copy it before installing.
COPY package.json bun.lock ./
COPY patches ./patches
RUN --mount=type=cache,target=/root/.bun/install/cache \
    bun install --frozen-lockfile

# Frontend sources (node_modules is excluded via .dockerignore, so the layer
# above is not clobbered).
COPY . .

# The wasm-pack output built in the Rust stage. `vite build` resolves
# `$lib/wasm/pkg` from here; without it the build fails at load-fallback. Copied
# AFTER `COPY . .` so it is not clobbered (the host tree never carries pkg/ — it
# is a gitignored build output).
COPY --from=rust-build /app/wasm-pkg ./src/lib/wasm/pkg

# SUNSTONE_TARGET=web selects adapter-node (see svelte.config.js); output -> build/.
RUN SUNSTONE_TARGET=web bun run build

# Prune to a PRODUCTION-only node_modules for the runtime image. adapter-node
# bundles the app but leaves externalized deps (e.g. `yaml`) to be resolved from
# node_modules at runtime.
RUN --mount=type=cache,target=/root/.bun/install/cache \
    rm -rf node_modules \
 && bun install --frozen-lockfile --production

# ---------------------------------------------------------------------------
# Stage 3 — Runtime: slim node image running both processes.
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    SUNSTONE_API_PORT=8787 \
    SUNSTONE_API_INTERNAL=http://localhost:8787 \
    SUNSTONE_BUNDLE=/bundle

# git is the backend of the write path (sunstone-server commits via the system
# `git` binary) and of the git sync loop. The slim base omits it, so install it.
# openssh-client comes along because `git` SHELLS OUT to `ssh` for SSH transport:
# without it the git-synced shape cannot clone/fetch/push at all. Both are
# harmless for the read-only deployment.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git openssh-client ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# Rust API binary + the adapter-node build + its production node_modules.
COPY --from=rust-build /usr/local/bin/sunstone-server /usr/local/bin/sunstone-server
COPY --from=web-build /app/build ./build
COPY --from=web-build /app/node_modules ./node_modules
COPY --from=web-build /app/package.json ./package.json

COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

# Bake the repo's docs/ in as an OPTIONAL bundle seed source. Unused by the
# default (read-only) deployment — it sets SUNSTONE_BUNDLE elsewhere and never
# reads /bundle-src. The Dex dev stack (docker-compose.dex.yml) sets
# SUNSTONE_BUNDLE_SEED_FROM=/bundle-src so the SERVER copies it into the resolved
# bundle root and seed-commits there. Baked in (not bind-mounted) because this
# sandbox's Docker daemon does not share the host filesystem.
COPY docs /bundle-src

# /srv/repo — the clone (a named volume in the git-synced stack).
# /srv/ssh  — the deploy key + known_hosts (NEVER a volume; dies with the container).
# Docker copies the IMAGE DIRECTORY's owner onto a freshly created named volume,
# so chowning here makes the volume writable by uid 1000 BY CONSTRUCTION — no
# chown step at boot, no gosu, no root at PID 1.
RUN mkdir -p /srv/repo /srv/ssh \
 && chown node:node /srv/repo /srv/ssh

# Public SSR web port (the Rust API on 8787 stays internal to the container).
EXPOSE 3000

# LAST in the stage, after every COPY and the entrypoint chmod: the build output
# stays root:root 0755 and only ever needs to be READ, so /app is deliberately
# not chowned. Both ports (3000, 8787) are >1024, so non-root needs no capability.
USER node

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
