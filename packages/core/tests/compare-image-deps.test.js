// packages/core/tests/compare-image-deps.test.js
//
// Tests for scripts/compare-image-deps.mjs
//
// Builds small image trees and lockfiles on disk and runs the script against
// them. Covers:
//   - every package pinned for the workspace (pass, exit 0)
//   - peer dependencies are followed; two versions of one package are a note
//   - a version that is in no lockfile entry (fail, exit 1)
//   - a version pinned only for another workspace, or only as a dev dependency
//     (warning, exit 0)
//   - workspace manifest carrying another version than the lockfile (fail)
//   - scoped, nested and linked packages are listed once
//   - nothing listed, an entry without a version (error, exit 2)
//   - a package.json under node_modules that is not a JSON object (error,
//     exit 2); a directory that holds none is passed over
//   - a directory that must be examined and cannot be listed, read or
//     resolved (error, exit 2), brought about by a failing fs method and, on
//     POSIX as a plain user, by real permission bits
//   - unreadable lockfile, lockfile without a packages map, unknown workspace,
//     usage errors (error, exit 2)
//   - --json report
//   - --image runs the listing inside the container (POSIX runners only)

import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.resolve(__dirname, "../../../scripts/compare-image-deps.mjs");
const WORKSPACE = "packages/web-dashboard";

// Two workspaces share one lockfile. The dashboard's tree is: a, @scope/b with
// its own d@1.5.0, the react@19.2.8 that @scope/b takes as a peer from the
// root, and its own nested react@19.2.4. left-pad belongs to the other
// workspace, d@2.0.0 reaches neither, and eslint is a dev dependency.
const makeLock = () => ({
  name: "root",
  version: "1.0.0",
  lockfileVersion: 3,
  requires: true,
  packages: {
    "": { name: "root", version: "1.0.0", devDependencies: { eslint: "^9.0.0" } },
    [WORKSPACE]: { name: "web-dashboard", version: "0.23.1", dependencies: { a: "1.0.0", "@scope/b": "^2.0.0", react: "19.2.4" } },
    "packages/other": { name: "other", version: "0.23.1", dependencies: { react: "^19.1.0", "left-pad": "1.0.0" } },
    "node_modules/a": { version: "1.0.0" },
    "node_modules/@scope/b": { version: "2.0.0", dependencies: { d: "^1.0.0" }, peerDependencies: { react: "^19.0.0" } },
    "node_modules/@scope/b/node_modules/d": { version: "1.5.0" },
    "node_modules/d": { version: "2.0.0" },
    "node_modules/react": { version: "19.2.8" },
    "node_modules/left-pad": { version: "1.0.0" },
    "node_modules/eslint": { version: "9.0.0", dev: true },
    [`${WORKSPACE}/node_modules/react`]: { version: "19.2.4" },
  },
});

// What an image built from that lockfile holds: the workspace manifest and
// the packages its production tree resolves to.
const TREE_PACKAGES = [
  ["node_modules/a", "a", "1.0.0"],
  ["node_modules/@scope/b", "@scope/b", "2.0.0"],
  ["node_modules/@scope/b/node_modules/d", "d", "1.5.0"],
  ["node_modules/react", "react", "19.2.8"],
  [`${WORKSPACE}/node_modules/react`, "react", "19.2.4"],
];

let dir;
let image;
let lockfile;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "compare-image-deps-"));
  image = path.join(dir, "image");
  lockfile = path.join(dir, "package-lock.json");
  writeManifest(WORKSPACE, "web-dashboard", "0.23.1");
  for (const [rel, name, version] of TREE_PACKAGES) writeManifest(rel, name, version);
  writeLock(makeLock());
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function writeManifest(rel, name, version) {
  const file = path.join(image, rel, "package.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(version === undefined ? { name } : { name, version }));
}

function writeLock(lock) {
  fs.writeFileSync(lockfile, typeof lock === "string" ? lock : JSON.stringify(lock, null, 2));
}

function runScript(args, env = {}) {
  try {
    const stdout = execFileSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", timeout: 20000, env: { ...process.env, ...env } });
    return { status: 0, stdout, stderr: "" };
  } catch (err) {
    return { status: err.status, stdout: err.stdout || "", stderr: err.stderr || "" };
  }
}

// Lists the fixture image on disk. Later arguments win over the first two.
const run = (args) => runScript(["--dir", image, "--lockfile", lockfile, ...args]);

// The listing runs in a child Node process. A file-system failure is brought
// about there through a module the child loads before anything else: it
// replaces one fs method so that the method fails, with the given error code,
// for every path that ends with one of `targets`.
function failInListing(method, code, targets) {
  const stub = path.join(dir, `fail-${method}.cjs`);
  fs.writeFileSync(
    stub,
    [
      "const fs = require('node:fs');",
      "const targets = (process.env.FAIL_PATHS || '').split(';').filter(Boolean);",
      "const method = process.env.FAIL_METHOD;",
      "const real = fs[method];",
      "fs[method] = function (target, ...rest) {",
      "  const p = String(target).split('\\\\').join('/');",
      "  if (targets.some((t) => p.endsWith(t))) {",
      "    const err = new Error(`simulated ${process.env.FAIL_CODE} for ${p}`);",
      "    err.code = process.env.FAIL_CODE;",
      "    throw err;",
      "  }",
      "  return real.call(this, target, ...rest);",
      "};",
    ].join("\n") + "\n",
  );
  // Node reads NODE_OPTIONS with backslashes as escapes, so the path uses slashes.
  const preload = stub.split(path.sep).join("/");
  return {
    NODE_OPTIONS: `${process.env.NODE_OPTIONS || ""} --require "${preload}"`.trim(),
    FAIL_METHOD: method,
    FAIL_CODE: code,
    FAIL_PATHS: targets.join(";"),
  };
}

const runFailing = (method, code, targets) => runScript(["--dir", image, "--lockfile", lockfile], failInListing(method, code, targets));

describe("compare-image-deps", () => {
  it("passes when every package in the image is pinned for the workspace", () => {
    const result = run([]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("packages listed: 5");
    expect(result.stdout).toContain("5 of 5 packages are pinned by the lockfile");
    expect(result.stdout).not.toContain("WARNING");
    expect(result.stdout).toContain("result: PASS");
  });

  it("follows peer dependencies and notes two versions of one package", () => {
    const result = run([]);
    // react@19.2.8 is reachable only as @scope/b's peer dependency.
    expect(result.stdout).toMatch(/OK\s+react@19\.2\.8\s+at node_modules\/react/);
    expect(result.stdout).toMatch(/OK\s+react@19\.2\.4\s+at packages\/web-dashboard\/node_modules\/react/);
    expect(result.stdout).toContain("react is present at 2 versions: 19.2.4, 19.2.8");
    expect(result.stdout).toContain("::notice title=compare-image-deps::react is present at 2 versions");
  });

  it("fails when the image carries a version that is in no lockfile entry", () => {
    writeManifest("node_modules/@scope/b/node_modules/d", "d", "1.5.1");
    const result = run([]);
    expect(result.status).toBe(1);
    expect(result.stdout).toMatch(/NOT IN LOCKFILE\s+d@1\.5\.1/);
    expect(result.stdout).toContain("d@1.5.1 at node_modules/@scope/b/node_modules/d is in no lockfile entry");
    expect(result.stdout).toContain("::error title=compare-image-deps::d@1.5.1");
    expect(result.stdout).toContain("result: FAIL (1)");
  });

  it("lists every unpinned version, not only the first", () => {
    writeManifest("node_modules/a", "a", "1.0.1");
    writeManifest("node_modules/@scope/b/node_modules/d", "d", "1.5.1");
    const result = run([]);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("a@1.0.1 at node_modules/a is in no lockfile entry");
    expect(result.stdout).toContain("d@1.5.1 at node_modules/@scope/b/node_modules/d is in no lockfile entry");
    expect(result.stdout).toContain("result: FAIL (2)");
  });

  it("warns, without failing, about a version pinned only for another workspace or as a dev dependency", () => {
    writeManifest("node_modules/left-pad", "left-pad", "1.0.0");
    writeManifest("node_modules/eslint", "eslint", "9.0.0");
    const result = run([]);
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/OUTSIDE THE WORKSPACE TREE\s+left-pad@1\.0\.0\s+at node_modules\/left-pad\s+lockfile has it at node_modules\/left-pad/);
    expect(result.stdout).toMatch(/OUTSIDE THE WORKSPACE TREE\s+eslint@9\.0\.0\s+at node_modules\/eslint/);
    expect(result.stdout).toContain("::warning title=compare-image-deps::2 package(s)");
    expect(result.stdout).toContain("outside the packages/web-dashboard tree: eslint@9.0.0, left-pad@1.0.0");
    expect(result.stdout).toContain("result: PASS");
  });

  it("fails when the workspace manifest carries another version than the lockfile", () => {
    writeManifest(WORKSPACE, "web-dashboard", "0.24.0");
    const result = run([]);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("does not carry the version the lockfile records for packages/web-dashboard");
    expect(result.stdout).toContain("result: FAIL (1)");
  });

  it("lists a linked workspace once, under its link path", () => {
    const link = path.join(image, "node_modules", "web-dashboard");
    fs.symlinkSync(path.join(image, WORKSPACE), link, "junction");
    try {
      const result = run([]);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("packages listed: 6");
      expect(result.stdout).toMatch(/OK\s+web-dashboard@0\.23\.1\s+at node_modules\/web-dashboard/);
      // The nested package is found through the link and listed exactly once.
      expect(result.stdout.match(/OK\s+react@19\.2\.4\s+at /g)).toHaveLength(1);
      expect(result.stdout).toMatch(/OK\s+react@19\.2\.4\s+at node_modules\/web-dashboard\/node_modules\/react/);
    } finally {
      fs.rmSync(link, { force: true }); // the link itself, never what it points at
    }
  });

  it("writes a JSON report with the status of every package", () => {
    const report = path.join(dir, "report.json");
    writeManifest("node_modules/left-pad", "left-pad", "1.0.0");
    writeManifest("node_modules/eslint", "eslint", "9.9.9");
    const result = run(["--json", report]);
    expect(result.status).toBe(1);
    const parsed = JSON.parse(fs.readFileSync(report, "utf8"));
    expect(parsed.source).toBe(image);
    expect(parsed.workspace).toBe(WORKSPACE);
    expect(parsed.pass).toBe(false);
    expect(parsed.packages.find((p) => p.name === "react" && p.version === "19.2.8").status).toBe("ok");
    expect(parsed.packages.find((p) => p.name === "left-pad").status).toBe("outside-tree");
    expect(parsed.packages.find((p) => p.name === "eslint").status).toBe("unpinned");
    expect(parsed.notes).toContain("react is present at 2 versions: 19.2.4, 19.2.8");
  });

  it("exits 2 when nothing is listed", () => {
    for (const [rel] of TREE_PACKAGES) fs.rmSync(path.join(image, rel), { recursive: true, force: true });
    const result = run([]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("no packages were listed");
  });

  it("exits 2 for a listed entry without a version", () => {
    writeManifest("node_modules/nameless", "nameless", undefined);
    const result = run([]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("malformed listing entry");
  });

  it.each([
    ["truncated JSON", '{"name": "broken",'],
    ["an empty file", ""],
    ["a JSON array", "[]"],
    ["a JSON string", '"not a manifest"'],
    ["JSON null", "null"],
  ])("exits 2 when a package.json under node_modules holds %s", (_label, content) => {
    // A package the check cannot read must stop the check. It must not vanish.
    const file = path.join(image, "node_modules", "broken", "package.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    const result = run([]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("1 package.json file(s) under node_modules");
    expect(result.stderr).toContain("could not be read as a JSON object: node_modules/broken");
    expect(result.stdout).not.toContain("result:");
  });

  it("names every unreadable package.json, in a scope and in a nested node_modules", () => {
    const nested = path.join(image, "node_modules", "@scope", "b", "node_modules", "broken", "package.json");
    fs.mkdirSync(path.dirname(nested), { recursive: true });
    fs.writeFileSync(nested, "{");
    const scoped = path.join(image, "node_modules", "@broken", "pkg", "package.json");
    fs.mkdirSync(path.dirname(scoped), { recursive: true });
    fs.writeFileSync(scoped, "null");
    const result = run([]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("2 package.json file(s)");
    expect(result.stderr).toContain("node_modules/@broken/pkg, node_modules/@scope/b/node_modules/broken");
  });

  it("passes over directories under node_modules that hold no package.json", () => {
    for (const rel of ["node_modules/.vite/deps.json", "node_modules/tmp/x.js", "node_modules/@scope/notes.txt"]) {
      const file = path.join(image, rel);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, "x");
    }
    const result = run([]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("packages listed: 5");
    expect(result.stdout).toContain("result: PASS");
  });

  it("fails when the workspace's own package.json cannot be read", () => {
    fs.writeFileSync(path.join(image, WORKSPACE, "package.json"), "{");
    const result = run([]);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("does not carry the version the lockfile records for packages/web-dashboard");
  });

  it("exits 2 when the lockfile cannot be read", () => {
    const result = run(["--lockfile", path.join(dir, "missing.json")]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("could not read lockfile");
  });

  it("exits 2 for a lockfile without a packages map", () => {
    writeLock(JSON.stringify({ name: "root", version: "1.0.0" }));
    const result = run([]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("has no packages map");
  });

  it("exits 2 for a workspace that is not in the lockfile", () => {
    const result = run(["--workspace", "packages/nowhere"]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("workspace packages/nowhere is not in the lockfile");
  });

  it("exits 2 on a usage error", () => {
    expect(runScript([]).stderr).toContain("pass exactly one of --image <ref> or --dir <path>");
    expect(runScript(["--dir", image, "--image", "test-image:1"]).stderr).toContain("pass exactly one of --image <ref> or --dir <path>");
    expect(runScript(["--workspace"]).stderr).toContain("--workspace needs a value");
    expect(runScript(["--bogus"]).stderr).toContain("unknown argument: --bogus");
    expect(runScript(["--bogus"]).status).toBe(2);
    expect(runScript(["--bogus"]).stderr).toContain("usage: node scripts/compare-image-deps.mjs");
  });

  // The fake docker needs a shebang, which Windows does not honour without a shell.
  const itOnPosix = process.platform === "win32" ? it.skip : it;
  // Permission bits do not restrict the superuser.
  const itOnPosixAsUser = process.platform === "win32" || process.getuid?.() === 0 ? it.skip : it;

  const writeFakeDocker = () => {
    const fakeDocker = path.join(dir, "fake-docker");
    const callLog = path.join(dir, "docker-call.txt");
    // Records its arguments, then runs what follows the image name with node,
    // which is exactly what the real `docker run --entrypoint node` does.
    fs.writeFileSync(fakeDocker, '#!/bin/sh\nprintf \'%s\\n\' "$*" > "$FAKE_DOCKER_CALL_LOG"\nwhile [ "$1" != "test-image:1" ] && [ "$#" -gt 0 ]; do shift; done\n[ "$#" -gt 0 ] && shift\nexec node "$@"\n');
    fs.chmodSync(fakeDocker, 0o755);
    return { DOCKER: fakeDocker, FAKE_DOCKER_CALL_LOG: callLog, callLog };
  };

  describe("a directory that cannot be examined", () => {
    // An empty answer for a directory that could not be listed would let the
    // check pass over packages it never saw.
    it.each([
      ["the node_modules directory inside a package", ["node_modules/@scope/b/node_modules"]],
      ["a scope directory", ["node_modules/@scope"]],
      ["the top-level node_modules directory", ["node_modules"]],
      ["a directory on the way down from the root", ["packages"]],
    ])("exits 2 instead of passing when %s cannot be listed", (_label, targets) => {
      const result = runFailing("readdirSync", "EACCES", targets);
      expect(result.status).toBe(2);
      expect(result.stderr).toContain("1 directory inside");
      expect(result.stderr).toContain("could not be examined");
      expect(result.stderr).toContain(`${targets[0]} (EACCES)`);
      expect(result.stdout).not.toContain("result:");
    });

    it("names the error it met", () => {
      const result = runFailing("readdirSync", "EIO", ["node_modules/@scope/b/node_modules"]);
      expect(result.status).toBe(2);
      expect(result.stderr).toContain("node_modules/@scope/b/node_modules (EIO)");
    });

    it("exits 2 when a directory's own status cannot be read", () => {
      const result = runFailing("statSync", "EACCES", ["node_modules/@scope/b/node_modules"]);
      expect(result.status).toBe(2);
      expect(result.stderr).toContain("could not be examined");
      expect(result.stderr).toContain("node_modules/@scope/b/node_modules (EACCES)");
    });

    it("exits 2 when a directory's real path cannot be resolved", () => {
      const result = runFailing("realpathSync", "ELOOP", ["node_modules/@scope"]);
      expect(result.status).toBe(2);
      expect(result.stderr).toContain("node_modules/@scope (ELOOP)");
    });

    it("exits 2 when a package's package.json is there and cannot be read", () => {
      const result = runFailing("readFileSync", "EACCES", ["node_modules/react/package.json"]);
      expect(result.status).toBe(2);
      expect(result.stderr).toContain("could not be examined");
      expect(result.stderr).toContain("node_modules/react/package.json (EACCES)");
    });

    it("exits 2 when the workspace's own package.json cannot be read", () => {
      const result = runFailing("readFileSync", "EACCES", ["packages/web-dashboard/package.json"]);
      expect(result.status).toBe(2);
      expect(result.stderr).toContain("packages/web-dashboard/package.json (EACCES)");
    });

    itOnPosixAsUser("exits 2 when the process may not list a node_modules directory inside a package", () => {
      const nested = path.join(image, "node_modules", "@scope", "b", "node_modules");
      fs.chmodSync(nested, 0o000);
      try {
        const result = run([]);
        expect(result.status).toBe(2);
        expect(result.stderr).toContain("node_modules/@scope/b/node_modules (EACCES)");
      } finally {
        fs.chmodSync(nested, 0o755);
      }
    });

    itOnPosixAsUser("exits 2 when the process may not read a package directory", () => {
      const pkg = path.join(image, "node_modules", "react");
      fs.chmodSync(pkg, 0o000);
      try {
        const result = run([]);
        expect(result.status).toBe(2);
        expect(result.stderr).toContain("node_modules/react/package.json (EACCES)");
      } finally {
        fs.chmodSync(pkg, 0o755);
      }
    });

    itOnPosix("passes over a symbolic link under node_modules that points at nothing", () => {
      const link = path.join(image, "node_modules", "dangling");
      fs.symlinkSync(path.join(image, "nowhere"), link, "dir");
      try {
        const result = run([]);
        expect(result.status).toBe(0);
        expect(result.stdout).toContain("packages listed: 5");
      } finally {
        fs.rmSync(link, { force: true });
      }
    });
  });

  itOnPosix("lists through docker run for --image", () => {
    const fake = writeFakeDocker();
    const result = runScript(["--image", "test-image:1", "--lockfile", lockfile, "--root", image], fake);
    const call = fs.readFileSync(fake.callLog, "utf8");
    expect(call).toMatch(/^run --rm --pull never --network none --entrypoint node test-image:1 -e /);
    expect(call).toContain("function listInstalled");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("5 of 5 packages are pinned by the lockfile");
  });

  itOnPosix("exits 2 for --image when a directory inside the image cannot be listed", () => {
    const fake = writeFakeDocker();
    const result = runScript(["--image", "test-image:1", "--lockfile", lockfile, "--root", image], {
      ...fake,
      ...failInListing("readdirSync", "EACCES", ["node_modules/@scope/b/node_modules"]),
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("1 directory inside image test-image:1 could not be examined");
    expect(result.stderr).toContain("node_modules/@scope/b/node_modules (EACCES)");
  });
});
