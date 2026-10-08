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
    // Return matched rule IDENTIFIERS ONLY — never action definitions. The
    // app-side authority boundary reconstructs actions exclusively from the
    // trusted resolved configuration; untrusted sandbox output must not be
    // able to invent actions outside the configured policy. (A plugin may
    // still influence WHICH configured rules match — that is plugin
    // filters' intended function; their results are not intrinsically
    // trustworthy.)
    process.stdout.write(JSON.stringify({ ok: true, matchedRuleNames: matched.map((m) => m.name) }));
    return;
  }

  if (input.kind === "playground") {
    const { evaluateExpr, evaluateExprWithTrace } = await import("@gitwire/rules/expr");
    // Named-expression resolution, identical to the pre-isolation app route:
    // groups resolve into an enriched context BEFORE the main expression is
    // evaluated, and each named expression sees the plugin filters too.
    // (evaluateExprWithTrace takes three arguments; passing expressions as a
    // fourth would silently drop them.)
    const exprContext = { ...(input.context ?? {}) };
    for (const [groupName, group] of Object.entries(input.expressions ?? {})) {
      if (typeof group === "object" && group !== null) {
        exprContext[groupName] = {};
        for (const [key, expr] of Object.entries(group)) {
          try {
            exprContext[groupName][key] = evaluateExpr(expr, input.context ?? {}, pluginFilters);
          } catch (_e) {
            exprContext[groupName][key] = undefined;
          }
        }
      } else if (typeof group === "string") {
        try {
          exprContext[groupName] = evaluateExpr(group, input.context ?? {}, pluginFilters);
        } catch (_e) {
          exprContext[groupName] = undefined;
        }
      }
    }
    const result = evaluateExprWithTrace(input.expression, exprContext, pluginFilters);
    process.stdout.write(JSON.stringify({ ok: true, result }));
    return;
  }

  process.stdout.write(JSON.stringify({ ok: false, error: `unknown kind: ${input.kind}` }));
}

main().catch((err) => {
  process.stdout.write(JSON.stringify({ ok: false, error: String(err?.message || err) }));
});
