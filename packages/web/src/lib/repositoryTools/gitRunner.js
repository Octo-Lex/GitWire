// Sterile Git subprocess runner for RepositoryTools v2 (RI-9 amendment).
//
// Every git invocation runs hermetically: no system or global config, no
// inherited GIT_* environment, no repository hooks, no credential helpers.
// The session owns a private HOME and an empty global-config file, so
// host-controlled or repository-controlled configuration cannot silently
// alter repository truth observed by the reviewer.

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export const GIT_BINARY = process.env.GITWIRE_GIT_BIN || "git";

// Default capture ceiling for git stdout/stderr. Operations apply their own
// output budgets on top; this cap only stops runaway processes.
const MAX_CAPTURE_BYTES = 64 * 1024 * 1024;

/**
 * Fixed `-c` config applied to every invocation. Determinism and safety:
 * no line-ending conversion, raw UTF-8 path output, hooks pinned to an
 * empty directory, and file:// remotes allowed for internal/test use.
 */
function baseConfigArgs(hooksDir) {
  return [
    "-c", "core.autocrlf=false",
    "-c", "core.eol=lf",
    "-c", "core.quotepath=false",
    "-c", `core.hooksPath=${hooksDir}`,
    "-c", "protocol.file.allow=always",
    "-c", "core.fsck.ignoreEnvironment=1",
  ];
}

/**
 * Build the sterile environment for a session.
 * Strips every inherited GIT_* variable (including GIT_DIR/GIT_WORK_TREE
 * hijacks), then pins HOME and config to session-owned paths.
 *
 * @param {string} home session-private HOME directory
 * @param {string} globalConfig path to an empty global config file
 * @returns {object} env for child_process.spawn
 */
export function buildSterileEnv(home, globalConfig) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith("GIT_")) continue;
    env[key] = value;
  }
  env.HOME = home;
  env.GIT_CONFIG_NOSYSTEM = "1";
  env.GIT_CONFIG_GLOBAL = globalConfig;
  env.GIT_TERMINAL_PROMPT = "0";
  env.GIT_LFS_SKIP_SMUDGE = "1";
  env.GIT_ASKPASS = "";
  env.SSH_ASKPASS = "";
  env.SSH_ASKPASS_REQUIRE = "never";
  return env;
}

/**
 * Prepare the session-owned filesystem skeleton (home, empty global config,
 * empty hooks directory).
 *
 * @param {string} root session root directory
 * @returns {{ home: string, globalConfig: string, hooksDir: string }}
 */
export function prepareSterileSkeleton(root) {
  const home = path.join(root, "home");
  const hooksDir = path.join(home, "hooks");
  const globalConfig = path.join(home, "gitconfig-empty");
  fs.mkdirSync(hooksDir, { recursive: true });
  fs.writeFileSync(globalConfig, "", "utf8");
  return { home, globalConfig, hooksDir };
}

/**
 * Run git with the session's sterile environment.
 *
 * @param {object} options
 * @param {string[]} options.args git arguments (without the binary)
 * @param {string} options.cwd working directory for the invocation
 * @param {string} options.home session HOME
 * @param {string} options.globalConfig empty global config path
 * @param {string} options.hooksDir empty hooks directory
 * @param {object} [options.env] extra env vars merged last (credential
 *        plumbing during acquisition only — never persisted)
 * @param {number} [options.timeoutMs] wall-clock kill deadline
 * @param {AbortSignal} [options.signal] cooperative cancellation
 * @param {string} [options.stdin] stdin payload
 * @param {number} [options.maxCaptureBytes] stdout/stderr ceiling
 * @returns {Promise<{code: number, stdout: Buffer, stderr: string,
 *           timedOut: boolean, cancelled: boolean}>}
 */
export async function runGit(options) {
  const {
    args,
    cwd,
    home,
    globalConfig,
    hooksDir,
    env = {},
    timeoutMs,
    signal,
    stdin,
    maxCaptureBytes = MAX_CAPTURE_BYTES,
  } = options;

  const argv = [...baseConfigArgs(hooksDir), ...args];
  const sterile = buildSterileEnv(home, globalConfig);

  return await new Promise((resolve) => {
    const child = spawn(GIT_BINARY, argv, {
      cwd,
      env: { ...sterile, ...env },
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = Buffer.alloc(0);
    let stderr = "";
    let stdoutCapped = false;
    let timedOut = false;
    let cancelled = false;
    let settled = false;

    const timer = timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill("SIGTERM");
        }, timeoutMs)
      : null;

    const onAbort = () => {
      cancelled = true;
      child.kill("SIGTERM");
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }

    child.stdout.on("data", (chunk) => {
      if (stdout.length + chunk.length <= maxCaptureBytes) {
        stdout = Buffer.concat([stdout, chunk]);
      } else {
        stdoutCapped = true;
        child.kill("SIGTERM");
      }
    });
    child.stderr.on("data", (chunk) => {
      if (stderr.length < 65536) stderr += chunk.toString("utf8");
    });

    const settle = (code) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
      resolve({
        code,
        stdout,
        stderr,
        timedOut,
        cancelled,
        stdoutCapped,
      });
    };

    child.on("error", (err) => {
      stderr += `\nspawn error: ${err.message}`;
      settle(-1);
    });
    child.on("close", (code) => settle(code));

    if (stdin !== undefined) {
      child.stdin.on("error", () => {});
      child.stdin.end(stdin);
    } else {
      child.stdin.end();
    }
  });
}
