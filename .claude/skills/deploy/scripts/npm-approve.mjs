// Wait for the release workflow to stage a version's npm packages (and npm to
// finish validating them), check them,
// and print the `npm stage approve` command (fish syntax) for the user to run (approving
// needs their 2FA, so this script never approves anything itself).
//
//   node .claude/skills/deploy/scripts/npm-approve.mjs <X.Y.Z> [--timeout-min N]
//
// Only the packages npm/packages.mjs defines are considered. For each one there
// must be exactly one staged entry for <X.Y.Z>, staged by the npm user you're
// logged in as, under the `latest` tag. The staged launcher's tarball is
// downloaded and its optionalDependencies must be exactly the platform
// packages at <X.Y.Z>. Anything else staged for these packages (other
// versions) is listed and left alone. Exits non-zero if a check fails, or if
// the release run finishes (or the timeout passes) with packages missing.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PLATFORMS, launcher, platformPackage } from "../../../../npm/packages.mjs";

const args = process.argv.slice(2);
const version = args[0];
if (!/^\d+\.\d+\.\d+$/.test(version ?? "")) {
  console.error("usage: npm-approve.mjs <X.Y.Z> [--timeout-min N]");
  process.exit(2);
}
const ti = args.indexOf("--timeout-min");
const timeoutMs = (ti >= 0 ? Number(args[ti + 1]) : 60) * 60_000;
const POLL_MS = 30_000;

// `npm stage` needs npm >= 11.15; the system npm may be older.
const NPM = ["-y", "npm@^11.15.0"];
const npm = (...a) => execFileSync("npx", [...NPM, ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

const platforms = Object.keys(PLATFORMS).map(platformPackage);
// Platforms first: the launcher must not go live pointing at unpublished packages.
const expected = [...platforms, launcher.name];
const fail = (msg) => {
  console.error(`✗ ${msg}`);
  process.exit(1);
};

const me = npm("whoami").trim();
console.log(`Waiting for ${expected.length} packages @ ${version} to be staged (npm user: ${me}):`);
for (const p of expected) console.log(`  ${p}`);

/** The release workflow run for this tag, or null if gh can't tell. */
function releaseRun() {
  try {
    const out = execFileSync(
      "gh",
      ["run", "list", "--workflow", "release.yml", "--branch", `v${version}`, "--limit", "1", "--json", "status,conclusion,url"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
    return JSON.parse(out)[0] ?? null;
  } catch {
    return null;
  }
}

const deadline = Date.now() + timeoutMs;
let found;
for (;;) {
  found = new Map();
  const pending = [];
  const others = [];
  for (const pkg of expected) {
    const entries = JSON.parse(npm("stage", "list", pkg, "--json"));
    const mine = entries.filter((e) => e.version === version && (e.status === "staged" || e.status === "validating"));
    if (mine.length > 1) fail(`${pkg}@${version} is staged ${mine.length} times (${mine.map((e) => e.id).join(", ")}); reject the extras first`);
    // npm validates a staged package before it can be approved, which can take a while.
    if (mine[0]?.status === "validating") pending.push(pkg);
    else if (mine.length === 1) found.set(pkg, mine[0]);
    others.push(...entries.filter((e) => !mine.includes(e)));
  }
  if (found.size === expected.length) {
    for (const e of others) console.log(`  (ignoring ${e.packageName}@${e.version}, ${e.status}, id ${e.id})`);
    break;
  }
  const missing = expected.filter((p) => !found.has(p) && !pending.includes(p));
  const run = missing.length ? releaseRun() : null;
  if (run?.status === "completed") fail(`release run finished (${run.conclusion}) but not staged: ${missing.join(", ")}\n  ${run.url}`);
  if (Date.now() > deadline) fail(`timed out; not staged: ${missing.join(", ") || "-"}; still validating: ${pending.join(", ") || "-"}`);
  const waiting = [...missing.map((p) => `${p} (not staged)`), ...pending.map((p) => `${p} (validating)`)];
  console.log(`  ${found.size}/${expected.length} ready, waiting on ${waiting.join(", ")}…`);
  await new Promise((r) => setTimeout(r, POLL_MS));
}

for (const [pkg, e] of found) {
  if (e.packageName !== pkg) fail(`stage ${e.id} is for ${e.packageName}, expected ${pkg}`);
  if (e.actor !== me) fail(`${pkg}@${version} was staged by ${e.actor}, not ${me}`);
  if (e.tag !== "latest") fail(`${pkg}@${version} is staged under tag "${e.tag}", not "latest"`);
}

// The launcher must point at exactly these platform packages, at this version.
const dir = mkdtempSync(join(tmpdir(), "sunstone-npm-"));
try {
  execFileSync("npx", [...NPM, "stage", "download", found.get(launcher.name).id], { cwd: dir, stdio: "ignore" });
  const tgz = readdirSync(dir).find((f) => f.endsWith(".tgz"));
  const manifest = JSON.parse(execFileSync("tar", ["-xzOf", join(dir, tgz), "package/package.json"], { encoding: "utf8" }));
  if (manifest.name !== launcher.name || manifest.version !== version) fail(`launcher tarball is ${manifest.name}@${manifest.version}`);
  const deps = manifest.optionalDependencies ?? {};
  const want = Object.fromEntries(platforms.map((p) => [p, version]));
  if (JSON.stringify(Object.entries(deps).sort()) !== JSON.stringify(Object.entries(want).sort()))
    fail(`launcher optionalDependencies don't match:\n  got  ${JSON.stringify(deps)}\n  want ${JSON.stringify(want)}`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n✓ All ${expected.length} packages staged and checked. Run this in fish to approve them (2FA per package):\n`);
// fish: each `and` line runs only if the previous approval succeeded.
expected.forEach((p, i) =>
  console.log(`${i ? "and " : ""}npx -y npm@^11.15.0 stage approve ${found.get(p).id}  # ${p}@${version}`),
);
