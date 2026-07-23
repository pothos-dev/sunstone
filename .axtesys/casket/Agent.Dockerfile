# Per-project sandbox image for Sunstone (Tauri 2 + SvelteKit).
#
# Adds the Rust toolchain and the Tauri v2 Linux system libraries on top of the
# ax agent base image, so the Rust side (`cargo test`, `cargo check`, `cargo
# build`) can be compiled and tested inside the sandbox. The base image already
# ships node/npm/bun/ripgrep/build-essential for the frontend.

FROM depot.axtesys.lol/axtesys/casket/ax-casket:base

USER root

# Tauri v2 Linux build prerequisites (WebKitGTK et al.). Without these the
# `tauri` crate fails to compile, so `cargo test`/`cargo check` can't run.
# See https://tauri.app/start/prerequisites/#linux
RUN apt-get update && apt-get install -y --no-install-recommends \
        libwebkit2gtk-4.1-dev \
        libgtk-3-dev \
        libayatana-appindicator3-dev \
        librsvg2-dev \
        libssl-dev \
        libsoup-3.0-dev \
        libjavascriptcoregtk-4.1-dev \
        libxdo-dev \
        pkg-config \
        wget \
    && rm -rf /var/lib/apt/lists/*

USER nhp

# Install the Rust toolchain via rustup (into the nhp user's home so it persists
# alongside the other per-user state). Stable matches the crate's 2021 edition.
# The wasm32-unknown-unknown target + wasm-pack drive the WASM-shared-core build
# (ADR-0006): `wasm-pack build --target web` compiles `crates/sunstone-wasm`.
ENV RUSTUP_HOME=/home/nhp/.rustup \
    CARGO_HOME=/home/nhp/.cargo \
    PATH=/home/nhp/.cargo/bin:${PATH}
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
        | sh -s -- -y --no-modify-path --profile minimal --default-toolchain stable \
    && rustup target add wasm32-unknown-unknown \
    && rustc --version \
    && cargo --version

# wasm-pack: builds the wasm module + generates the JS/TS bindings (ADR-0006 §1).
RUN cargo install wasm-pack --locked \
    && wasm-pack --version
