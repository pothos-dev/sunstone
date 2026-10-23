#!/usr/bin/env node
// Runs the native `sunstone-cli` binary from the platform package npm installed
// alongside this one (an optionalDependency named `<this package>-<os>-<cpu>`,
// filtered by its `os`/`cpu` fields), passing the arguments through.
"use strict";

const { spawnSync } = require("node:child_process");
const { name } = require("../package.json");

const platformPkg = `${name}-${process.platform}-${process.arch}`;
const exe = process.platform === "win32" ? "sunstone-cli.exe" : "sunstone-cli";

let binary;
try {
  binary = require.resolve(`${platformPkg}/bin/${exe}`);
} catch {
  console.error(
    `sunstone: no prebuilt binary for ${process.platform}-${process.arch} (${platformPkg} is not installed).\n` +
      "If your package manager skipped optional dependencies, reinstall without --no-optional / --omit=optional.",
  );
  process.exit(1);
}

const result = spawnSync(binary, process.argv.slice(2), { stdio: "inherit" });
if (result.error) {
  console.error(`sunstone: ${result.error.message}`);
  process.exit(1);
}
// Ctrl+C reaches the child too; mirror how it ended.
if (result.signal) process.kill(process.pid, result.signal);
process.exit(result.status ?? 1);
