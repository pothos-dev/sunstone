// Stage the npm packages for one release: the launcher (npm/sunstone) plus one
// package per platform wrapping that platform's `sunstone-cli` binary.
//
//   node npm/stage.mjs <version> <binaries-dir> <out-dir>
//
// <binaries-dir> holds one subdirectory per platform key below (e.g.
// `linux-x64/sunstone-cli`). Writes <out-dir>/<package>/ for each package,
// ready for `npm publish` (a scoped package's directory is `@scope__name`).
// The package set lives in packages.mjs.
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PLATFORMS, launcher, platformPackage } from "./packages.mjs";

const [version, binDir, outDir] = process.argv.slice(2);
if (!version || !binDir || !outDir) {
  console.error("usage: node npm/stage.mjs <version> <binaries-dir> <out-dir>");
  process.exit(2);
}

const here = new URL(".", import.meta.url).pathname;
const optionalDependencies = {};

for (const [key, { exe, pkg: scopedName }] of Object.entries(PLATFORMS)) {
  const src = join(binDir, key, exe);
  if (!existsSync(src)) throw new Error(`missing binary: ${src}`);
  const [os, cpu] = key.split("-");
  const name = platformPackage(key);
  const dir = join(outDir, name.replace("/", "__"));
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
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ ...pkg, ...(scopedName && { publishConfig: { access: "public" } }) }, null, 2) + "\n",
  );
  optionalDependencies[name] = version;
}

const launcherDir = join(outDir, launcher.name);
cpSync(join(here, "sunstone"), launcherDir, { recursive: true });
writeFileSync(
  join(launcherDir, "package.json"),
  JSON.stringify({ ...launcher, version, optionalDependencies }, null, 2) + "\n",
);
console.log(`staged ${launcher.name}@${version} + ${Object.keys(PLATFORMS).length} platform packages in ${outDir}`);
