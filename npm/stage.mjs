// Stage the npm packages for one release: the launcher (npm/sunstone) plus one
// package per platform wrapping that platform's `sunstone-cli` binary.
//
//   node npm/stage.mjs <version> <binaries-dir> <out-dir>
//
// <binaries-dir> holds one subdirectory per platform key below (e.g.
// `linux-x64/sunstone-cli`). Writes <out-dir>/<package>/ for each package,
// ready for `npm publish`. Platform package names derive from the launcher's
// name, so renaming the package is one edit to npm/sunstone/package.json.
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Node's `process.platform`-`process.arch` → what the binary is called there.
const PLATFORMS = {
  "linux-x64": "sunstone-cli",
  "linux-arm64": "sunstone-cli",
  "darwin-x64": "sunstone-cli",
  "darwin-arm64": "sunstone-cli",
  // Blocked by npm's spam filter (support ticket #4896497); restore once the
  // name `sunstone-md-win32-x64` is allowed. CI still builds the binary.
  // "win32-x64": "sunstone-cli.exe",
};

const [version, binDir, outDir] = process.argv.slice(2);
if (!version || !binDir || !outDir) {
  console.error("usage: node npm/stage.mjs <version> <binaries-dir> <out-dir>");
  process.exit(2);
}

const here = new URL(".", import.meta.url).pathname;
const launcher = JSON.parse(readFileSync(join(here, "sunstone/package.json"), "utf8"));
const optionalDependencies = {};

for (const [key, exe] of Object.entries(PLATFORMS)) {
  const src = join(binDir, key, exe);
  if (!existsSync(src)) throw new Error(`missing binary: ${src}`);
  const [os, cpu] = key.split("-");
  const name = `${launcher.name}-${key}`;
  const dir = join(outDir, name);
  mkdirSync(join(dir, "bin"), { recursive: true });
  copyFileSync(src, join(dir, "bin", exe));
  chmodSync(join(dir, "bin", exe), 0o755);
  const pkg = {
    name,
    version,
    description: `The ${key} binary for ${launcher.name}`,
    repository: launcher.repository,
    license: launcher.license,
    os: [os],
    cpu: [cpu],
    files: ["bin"],
  };
  writeFileSync(join(dir, "package.json"), JSON.stringify(pkg, null, 2) + "\n");
  optionalDependencies[name] = version;
}

const launcherDir = join(outDir, launcher.name);
cpSync(join(here, "sunstone"), launcherDir, { recursive: true });
writeFileSync(
  join(launcherDir, "package.json"),
  JSON.stringify({ ...launcher, version, optionalDependencies }, null, 2) + "\n",
);
console.log(`staged ${launcher.name}@${version} + ${Object.keys(PLATFORMS).length} platform packages in ${outDir}`);
