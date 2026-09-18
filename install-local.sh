#!/usr/bin/env bash
# Build Sunstone in release mode and install the binary to ~/.local/bin/sunstone.
#
# Sunstone is CLI-launched (`sunstone ./docs`), so only the binary is needed —
# no installer bundles. `tauri build --no-bundle` builds the frontend (via the
# configured beforeBuildCommand) and compiles the release binary, skipping the
# slower .deb/.AppImage/etc. packaging.
#
# Usage:  ./install-local.sh
set -euo pipefail

# Run from the project root regardless of the caller's working directory.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

BIN_NAME="sunstone"
INSTALL_DIR="$HOME/.local/bin"
# Ask cargo where it actually builds, rather than assuming ./target. The repo is
# a cargo workspace (crates/* + src-tauri), so output does not land in
# src-tauri/target — but it does not necessarily land in ./target either: a
# `build.target-dir` in ~/.cargo/config.toml redirects it elsewhere entirely,
# and a stale ./target/release/sunstone left over from before that setting would
# then be installed silently. cargo metadata reports the real directory,
# accounting for CARGO_TARGET_DIR, the config and the workspace root alike.
TARGET_DIR="$(cargo metadata --format-version 1 --no-deps 2>/dev/null \
  | sed -n 's/.*"target_directory":"\([^"]*\)".*/\1/p')"
TARGET_DIR="${TARGET_DIR:-${CARGO_TARGET_DIR:-$SCRIPT_DIR/target}}"
BUILT_BIN="$TARGET_DIR/release/$BIN_NAME"

if ! command -v bun >/dev/null 2>&1; then
  echo "error: 'bun' is required but not found on PATH" >&2
  exit 1
fi

echo "==> Building $BIN_NAME (release, no bundle)…"
bun run tauri build --no-bundle

if [[ ! -x "$BUILT_BIN" ]]; then
  echo "error: expected binary not found at $BUILT_BIN" >&2
  exit 1
fi

echo "==> Installing to $INSTALL_DIR/$BIN_NAME"
mkdir -p "$INSTALL_DIR"
install -m 0755 "$BUILT_BIN" "$INSTALL_DIR/$BIN_NAME"

echo "==> Installed $("$INSTALL_DIR/$BIN_NAME" --version 2>/dev/null || echo "$BIN_NAME")"
case ":$PATH:" in
  *":$INSTALL_DIR:"*) ;;
  *) echo "note: $INSTALL_DIR is not on your PATH — add it to use 'sunstone' directly." ;;
esac
