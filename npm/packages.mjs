// The npm packages one release ships: the launcher (npm/sunstone) plus one
// package per platform wrapping that platform's `sunstone-cli` binary. Shared by
// stage.mjs (which builds them) and the /deploy skill's approve script (which
// only approves exactly these), so the two can't drift apart.
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Node's `process.platform`-`process.arch` → what the binary is called there,
// and optionally the package name when it isn't `<launcher>-<key>`.
export const PLATFORMS = {
  "linux-x64": { exe: "sunstone-cli" },
  "linux-arm64": { exe: "sunstone-cli" },
  "darwin-x64": { exe: "sunstone-cli" },
  "darwin-arm64": { exe: "sunstone-cli" },
  // npm's spam filter blocks the unscoped `sunstone-md-win32-x64` (support
  // ticket #4896497), so Windows lives under the owner's scope.
  "win32-x64": { exe: "sunstone-cli.exe", pkg: "@pothos-dev/sunstone-md-win32-x64" },
};

const here = new URL(".", import.meta.url).pathname;

/** The launcher's package.json (npm/sunstone/package.json). */
export const launcher = JSON.parse(readFileSync(join(here, "sunstone/package.json"), "utf8"));

/** The npm package name for a platform key. */
export const platformPackage = (key) => PLATFORMS[key].pkg ?? `${launcher.name}-${key}`;
