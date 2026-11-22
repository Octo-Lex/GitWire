#!/usr/bin/env node
// scripts/compare-image-deps.mjs
//
// Compares the packages inside a built image with the lockfile the image was
// installed from. An `npm install` that ignores the lockfile produces an image
// whose versions match nothing in it; this check makes that a build failure.
//
// Exits 0 when every package in the image is pinned by the lockfile, 1 when
// it is not, and 2 when the check itself could not run (image missing,
// unreadable lockfile, nothing listed). A package the lockfile pins only for
// another workspace is reported as a warning and does not fail the check;
// the standalone output of Next.js carries such lone manifest files.
//
// The comparison is by package name and version as declared in each
// package.json. That the file contents match those versions is what `npm ci`
// guarantees when it verifies the lockfile's integrity hashes.
//
// Usage:
//   node scripts/compare-image-deps.mjs --image <docker ref> [options]
//   node scripts/compare-image-deps.mjs --dir <path>         [options]
//
// --image <ref>        image to list. It is started once with node, without a
//                      network and without volumes, and only its package.json
//                      files are read.
// --dir <path>         list this directory on disk instead of starting a container.
// --workspace <path>   lockfile path of the workspace whose dependency tree is
//                      expected inside the image (default packages/web-dashboard).
// --lockfile <file>    lockfile to compare with (default package-lock.json).
// --root <dir>         directory to list inside the image (default /app).
// --json <file>        also write the full report to this file.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const EXIT_PASS = 0;
const EXIT_FAIL = 1;
const EXIT_ERROR = 2;

const USAGE = `usage: node scripts/compare-image-deps.mjs (--image <docker ref> | --dir <path>)
               [--workspace <lockfile path>] [--lockfile <file>] [--root <dir>] [--json <file>]`;

class UsageError extends Error {}

function parseArgs(argv) {
  const opts = { image: null, dir: null, workspace: "packages/web-dashboard", lockfile: "package-lock.json", root: "/app", json: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      if (i + 1 >= argv.length) throw new UsageError(`${arg} needs a value`);
      return argv[++i];
    };
    switch (arg) {
      case "--image":
        opts.image = value();
        break;
      case "--dir":
        opts.dir = value();
        break;
      case "--workspace":
        opts.workspace = value();
        break;
      case "--lockfile":
        opts.lockfile = value();
        break;
      case "--root":
        opts.root = value();
        break;
      case "--json":
        opts.json = value();
        break;
      default:
        throw new UsageError(`unknown argument: ${arg}`);
    }
  }
  if (Boolean(opts.image) === Boolean(opts.dir)) throw new UsageError("pass exactly one of --image <ref> or --dir <path>");
  return opts;
}

// Runs inside the image, or in a child Node process for --dir, and is sent
// there as source text: it is evaluated as CommonJS, which is why it uses
// require(), and it must not refer to anything outside its own body. It lists
// every directory that holds a package.json under any node_modules directory
// below `root`, following symbolic links once.
function listInstalled(root, workspace) {
  const fs = require("node:fs");
  const path = require("node:path");
  const packages = [];
  const entered = new Set();
  const manifestOf = (dir) => {
    try {
      return JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
    } catch {
      return null;
    }
  };
  const list = (dir) => {
    try {
      return fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    } catch {
      return [];
    }
  };
  // A directory, possibly reached through a symbolic link, not visited before.
  const enter = (dir) => {
    try {
      if (!fs.statSync(dir).isDirectory()) return false;
    } catch {
      return false;
    }
    const real = fs.realpathSync(dir);
    if (entered.has(real)) return false;
    entered.add(real);
    return true;
  };
  const scanNodeModules = (dir) => {
    if (!enter(dir)) return;
    for (const entry of list(dir)) {
      if (entry.name.startsWith(".")) continue;
      const child = path.join(dir, entry.name);
      if (entry.name.startsWith("@")) {
        if (!enter(child)) continue;
        for (const scoped of list(child)) {
          if (!scoped.name.startsWith(".")) record(path.join(child, scoped.name), `${entry.name}/${scoped.name}`);
        }
      } else {
        record(child, entry.name);
      }
    }
  };
  const record = (dir, fallbackName) => {
    const manifest = manifestOf(dir);
    if (!manifest || typeof manifest !== "object") return;
    packages.push({
      path: path.relative(root, dir).split(path.sep).join("/"),
      name: typeof manifest.name === "string" ? manifest.name : fallbackName,
      version: typeof manifest.version === "string" ? manifest.version : null,
    });
    scanNodeModules(path.join(dir, "node_modules"));
  };
  const walk = (dir) => {
    if (!enter(dir)) return;
    for (const entry of list(dir)) {
      if (entry.name.startsWith(".")) continue;
      const child = path.join(dir, entry.name);
      if (entry.name === "node_modules") scanNodeModules(child);
      else walk(child);
    }
  };
  walk(root);
  packages.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const app = manifestOf(path.join(root, workspace));
  const identity = (m) => (m && typeof m === "object" ? { name: typeof m.name === "string" ? m.name : null, version: typeof m.version === "string" ? m.version : null } : null);
  process.stdout.write(JSON.stringify({ packages, app: identity(app) }));
}

function parseListing(stdout, source) {
  let listing;
  try {
    listing = JSON.parse(stdout);
  } catch {
    throw new CheckError(`could not read the package listing from ${source}: output is not JSON`);
  }
  if (!listing || !Array.isArray(listing.packages) || listing.packages.length === 0) {
    throw new CheckError(`no packages were listed from ${source}: an empty image cannot pass this check`);
  }
  for (const p of listing.packages) {
    if (typeof p.path !== "string" || typeof p.name !== "string" || typeof p.version !== "string") {
      throw new CheckError(`malformed listing entry from ${source}: ${JSON.stringify(p)}`);
    }
  }
  return listing;
}

function listImage(opts) {
  const script = `(${listInstalled})(${JSON.stringify(opts.root)}, ${JSON.stringify(opts.workspace)})`;
  const docker = process.env.DOCKER || "docker";
  try {
    return parseListing(
      execFileSync(docker, ["run", "--rm", "--pull", "never", "--network", "none", "--entrypoint", "node", opts.image, "-e", script], {
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
      }),
      `image ${opts.image}`,
    );
  } catch (err) {
    if (err instanceof CheckError) throw err;
    const detail = String(err.stderr || err.message || err).trim().split("\n").slice(-5).join(" | ");
    throw new CheckError(`could not list image ${opts.image} with \`${docker} run\`: ${detail}`);
  }
}

function listDirectory(opts) {
  const root = path.resolve(opts.dir);
  if (!fs.existsSync(root)) throw new CheckError(`directory to list does not exist: ${opts.dir}`);
  const script = `(${listInstalled})(${JSON.stringify(root)}, ${JSON.stringify(opts.workspace)})`;
  try {
    return parseListing(execFileSync(process.execPath, ["-e", script], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] }), `directory ${opts.dir}`);
  } catch (err) {
    if (err instanceof CheckError) throw err;
    throw new CheckError(`could not list directory ${opts.dir}: ${String(err.stderr || err.message).trim().split("\n").slice(-5).join(" | ")}`);
  }
}

class CheckError extends Error {}

// ── Lockfile side ─────────────────────────────────────────────────────────

const lockName = (key) => key.slice(key.lastIndexOf("node_modules/") + "node_modules/".length);

// Resolves a dependency the way Node does: from the dependency's own
// directory first, then from each directory above it.
function resolveFrom(packages, from, name) {
  let dir = from;
  for (;;) {
    const key = `${dir ? `${dir}/` : ""}node_modules/${name}`;
    const entry = packages[key];
    if (entry) {
      // A link entry stands for the workspace that provides the package.
      if (entry.link) return packages[entry.resolved] ? { key: entry.resolved, entry: packages[entry.resolved] } : null;
      return { key, entry };
    }
    if (!dir) return null;
    if (dir.startsWith("node_modules/")) {
      const cut = dir.lastIndexOf("/node_modules/");
      dir = cut === -1 ? "" : dir.slice(0, cut);
    } else {
      const cut = dir.lastIndexOf("/");
      dir = cut === -1 ? "" : dir.slice(0, cut);
    }
  }
}

// Dependencies npm installs alongside a package: regular, optional, and peer
// dependencies that are not marked optional.
function dependencyNames(entry) {
  const names = new Set();
  for (const section of ["optionalDependencies", "dependencies"]) for (const name of Object.keys(entry[section] || {})) names.add(name);
  for (const name of Object.keys(entry.peerDependencies || {})) {
    if (!entry.peerDependenciesMeta?.[name]?.optional) names.add(name);
  }
  return names;
}

// Every lockfile entry the workspace's production tree can reach, keyed by
// lock path. The workspace itself counts as part of the tree: npm links it
// into node_modules under its name.
function productionTree(packages, workspace) {
  const root = packages[workspace];
  if (!root) throw new CheckError(`workspace ${workspace} is not in the lockfile`);
  const tree = new Map([[workspace, root]]);
  const queue = [[workspace, root]];
  while (queue.length) {
    const [from, entry] = queue.pop();
    for (const name of dependencyNames(entry)) {
      const resolved = resolveFrom(packages, from, name);
      if (!resolved || tree.has(resolved.key)) continue;
      tree.set(resolved.key, resolved.entry);
      queue.push([resolved.key, resolved.entry]);
    }
  }
  return tree;
}

function loadLockfile(lockfilePath) {
  let lock;
  try {
    lock = JSON.parse(fs.readFileSync(lockfilePath, "utf8"));
  } catch (err) {
    throw new CheckError(`could not read lockfile ${lockfilePath}: ${err.message}`);
  }
  if (!lock || typeof lock.packages !== "object" || lock.packages === null) {
    throw new CheckError(`lockfile ${lockfilePath} has no packages map (lockfileVersion 2 or 3 is required)`);
  }
  return lock.packages;
}

// ── Comparison ────────────────────────────────────────────────────────────

function compare(listing, packages, workspace) {
  const tree = productionTree(packages, workspace);
  // Every lockfile entry by the name and version it provides.
  const pinned = new Map();
  for (const [key, entry] of Object.entries(packages)) {
    if (typeof entry.version !== "string") continue;
    const name = typeof entry.name === "string" ? entry.name : lockName(key);
    const id = `${name}@${entry.version}`;
    if (!pinned.has(id)) pinned.set(id, []);
    pinned.get(id).push(key);
  }
  const rows = listing.packages.map((p) => {
    const id = `${p.name}@${p.version}`;
    const keys = pinned.get(id) || [];
    const inTree = keys.filter((k) => tree.has(k));
    const status = keys.length === 0 ? "unpinned" : inTree.length === 0 ? "outside-tree" : "ok";
    return { ...p, status, lockPaths: inTree.length > 0 ? inTree : keys };
  });
  // One package shipped at several versions is worth a look even when each
  // copy is pinned: it usually means two copies of a library such as react.
  const versions = new Map();
  for (const p of listing.packages) {
    if (!versions.has(p.name)) versions.set(p.name, new Set());
    versions.get(p.name).add(p.version);
  }
  const notes = [...versions]
    .filter(([, v]) => v.size > 1)
    .map(([name, v]) => `${name} is present at ${v.size} versions: ${[...v].sort().join(", ")}`)
    .sort();
  const expected = packages[workspace];
  const appOk = listing.app && expected ? listing.app.version === expected.version : false;
  return { rows, notes, appOk, treeSize: tree.size };
}

const LABEL = { ok: "OK", "outside-tree": "OUTSIDE THE WORKSPACE TREE", unpinned: "NOT IN LOCKFILE" };

function report(result, listing, opts) {
  const out = (line) => console.log(line);
  const rows = result.rows;
  const source = opts.image || opts.dir;
  out(`packages listed: ${rows.length}   (from ${source})`);
  out(`lockfile ${opts.lockfile}: ${result.treeSize} packages in the production tree of ${opts.workspace}`);
  out("");
  for (const r of rows) {
    const detail = r.status === "outside-tree" ? `   lockfile has it at ${r.lockPaths.join(", ")}` : "";
    out(`  ${LABEL[r.status].padEnd(24)} ${r.name}@${r.version}   at ${r.path}${detail}`);
  }
  for (const note of result.notes) {
    out(`  ${"NOTE".padEnd(24)} ${note}`);
    console.log(`::notice title=compare-image-deps::${note} (${source})`);
  }
  out("");
  const count = (status) => rows.filter((r) => r.status === status).length;
  out(`  ${"OK".padEnd(24)} ${count("ok")} of ${rows.length} packages are pinned by the lockfile and belong to the workspace tree`);
  const outside = rows.filter((r) => r.status === "outside-tree");
  if (outside.length > 0) {
    const text = `${outside.length} package(s) in ${source} are pinned by the lockfile but outside the ${opts.workspace} tree: ${outside.map((r) => `${r.name}@${r.version}`).join(", ")}`;
    out(`  ${"WARNING".padEnd(24)} ${text}`);
    console.log(`::warning title=compare-image-deps::${text}`);
  }
  const failures = rows.filter((r) => r.status === "unpinned").map((r) => ({ text: `${r.name}@${r.version} at ${r.path} is in no lockfile entry` }));
  if (!result.appOk) {
    failures.push({ text: `the workspace manifest under ${opts.root}/${opts.workspace} does not carry the version the lockfile records for ${opts.workspace} (found ${JSON.stringify(listing.app)})` });
  }
  for (const f of failures) {
    out(`  ${"FAILED".padEnd(24)} ${f.text}`);
    console.log(`::error title=compare-image-deps::${f.text}`);
  }
  out("");
  out(failures.length === 0 ? "result: PASS" : `result: FAIL (${failures.length})`);
  return failures.length === 0 ? EXIT_PASS : EXIT_FAIL;
}

function main() {
  let opts;
  let result;
  let listing;
  try {
    opts = parseArgs(process.argv.slice(2));
    listing = opts.image ? listImage(opts) : listDirectory(opts);
    result = compare(listing, loadLockfile(opts.lockfile), opts.workspace);
  } catch (err) {
    if (err instanceof UsageError) console.error(USAGE);
    if (!(err instanceof UsageError || err instanceof CheckError)) throw err;
    console.error(`::error title=compare-image-deps::${err.message}`);
    process.exit(EXIT_ERROR);
  }
  if (opts.json) {
    const pass = result.rows.every((r) => r.status !== "unpinned") && result.appOk;
    fs.writeFileSync(opts.json, JSON.stringify({ source: opts.image || opts.dir, lockfile: opts.lockfile, workspace: opts.workspace, packages: result.rows, notes: result.notes, workspaceManifestMatchesLockfile: result.appOk, pass }, null, 2) + "\n");
  }
  process.exit(report(result, listing, opts));
}

main();
