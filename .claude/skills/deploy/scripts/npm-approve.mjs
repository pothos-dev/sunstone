// Wait for the release workflow to publish a version's npm platform packages
// and stage its launcher (and npm to finish validating it), check them, and
// print the `npm stage approve` command (fish syntax) for the user to run.
// Approving needs their 2FA, so this script never approves anything itself.
//
//   node .claude/skills/deploy/scripts/npm-approve.mjs <X.Y.Z> [--timeout-min N]
//
// Only the packages npm/packages.mjs defines are considered. Every platform
// package must be live at <X.Y.Z>. The launcher must have exactly one staged
// entry for <X.Y.Z> under the `latest` tag, staged by the release workflow
// (trusted publishing) or the logged-in npm user; its tarball is downloaded
// and its optionalDependencies must be exactly the platform packages at
// <X.Y.Z>. Other staged launcher versions are listed and left alone. Exits
// non-zero if a check fails, or if the release run finishes (or the timeout
// passes) with something missing.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
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
const fail = (msg) => {
  console.error(`✗ ${msg}`);
  process.exit(1);
};

let me;
try {
  me = npm("whoami").trim();
} catch {
  fail("not logged in to npm (`npm whoami` failed); run `npx -y npm@^11.15.0 login`, then this script again");
}
console.log(`Waiting for ${version}: ${platforms.length} platform packages published, ${launcher.name} staged (npm user: ${me})`);

/** Whether <pkg>@<version> is live on the registry. */
function published(pkg) {
  try {
    return npm("view", `${pkg}@${version}`, "version").trim() === version;
  } catch {
    return false;
  }
}

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
let stage;
for (;;) {
  const unpublished = platforms.filter((p) => !published(p));
  const entries = JSON.parse(npm("stage", "list", launcher.name, "--json"));
  const mine = entries.filter((e) => e.version === version && (e.status === "staged" || e.status === "validating"));
  if (mine.length > 1) fail(`${launcher.name}@${version} is staged ${mine.length} times (${mine.map((e) => e.id).join(", ")}); reject the extras first`);
  stage = mine[0];
  if (!unpublished.length && stage?.status === "staged") {
    for (const e of entries.filter((e) => e !== stage)) console.log(`  (ignoring ${e.packageName}@${e.version}, ${e.status}, id ${e.id})`);
    break;
  }
  // npm validates a staged package before it can be approved, which can take a while.
  const waiting = [...unpublished.map((p) => `${p} (not published)`), `${launcher.name} (${stage ? stage.status : "not staged"})`];
  const run = stage ? null : releaseRun();
  if (run?.status === "completed") fail(`release run finished (${run.conclusion}), still waiting on ${waiting.join(", ")}\n  ${run.url}`);
  if (Date.now() > deadline) fail(`timed out, still waiting on ${waiting.join(", ")}`);
  console.log(`  waiting on ${waiting.join(", ")}…`);
  await new Promise((r) => setTimeout(r, POLL_MS));
}

if (stage.packageName !== launcher.name) fail(`stage ${stage.id} is for ${stage.packageName}, expected ${launcher.name}`);
if (stage.tag !== "latest") fail(`${launcher.name}@${version} is staged under tag "${stage.tag}", not "latest"`);
// Trusted publishing stages as the workflow, not as a user; a user other than you is suspect.
if (stage.actorType === "user" && stage.actor !== me) fail(`${launcher.name}@${version} was staged by user ${stage.actor}, not ${me}`);
console.log(`  ${launcher.name}@${version} staged by ${stage.actor} (${stage.actorType})`);

// The launcher must point at exactly these platform packages, at this version.
const dir = mkdtempSync(join(tmpdir(), "sunstone-npm-"));
try {
  execFileSync("npx", [...NPM, "stage", "download", stage.id], { cwd: dir, stdio: "ignore" });
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

console.log(`\n✓ ${platforms.length} platform packages live, ${launcher.name}@${version} staged and checked. Run this to approve it (2FA):\n`);
console.log(`npx -y npm@^11.15.0 stage approve ${stage.id}  # ${launcher.name}@${version}`);
