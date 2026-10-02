// plugin-sandbox/runner.mjs — runs INSIDE the disposable sandbox container.
//
// This is the untrusted side of the #425 isolation boundary. Plugin sources
// are arbitrary JavaScript; executing them here is BY DESIGN: the surrounding
// container provides the OS boundary (network=none, read-only root, non-root,
// dropped capabilities, no-new-privileges, resource caps — see the Dockerfile
// and the executor's pluginSandboxRunner.js, which constructs the docker argv
// and never forwards caller-supplied argv, images, env, or mounts).
//
// Protocol (fixed): reads /sandbox/input.json, writes one JSON object to
// stdout. exit 0 = evaluation produced a result (check .ok for evaluation
// errors); any other exit or unparseable stdout is a sandbox failure and the
// executor fails closed.

import { readFileSync } from "node:fs";

const INPUT_PATH = "/sandbox/input.json";

async function main() {
  const raw = readFileSync(INPUT_PATH, "utf8");
  const input = JSON.parse(raw);

  const { loadPlugins } = await import("@gitwire/rules/plugins");

  let pluginFilters = {};
  if (Array.isArray(input.plugin_sources) && input.plugin_sources.length > 0) {
    // loadPlugins' in-sandbox execution (new Function) is the deliberate,
    // documented arbitrary-code path on the untrusted side of the boundary.
    pluginFilters = loadPlugins(input.plugin_sources);
  }

  if (input.kind === "custom_rules") {
    const { evaluateRules } = await import("@gitwire/rules");
    const matched = evaluateRules(input.ctx, input.config, pluginFilters);
    process.stdout.write(JSON.stringify({ ok: true, matched }));
    return;
  }

  if (input.kind === "playground") {
    const { evaluateExprWithTrace } = await import("@gitwire/rules/expr");
    const result = evaluateExprWithTrace(input.expression, input.context, pluginFilters, input.expressions);
    process.stdout.write(JSON.stringify({ ok: true, result }));
    return;
  }

  process.stdout.write(JSON.stringify({ ok: false, error: `unknown kind: ${input.kind}` }));
}

main().catch((err) => {
  process.stdout.write(JSON.stringify({ ok: false, error: String(err?.message || err) }));
});
