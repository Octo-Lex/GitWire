// Operator-side plugin authorization gate (#425 containment for CodeQL #12).
//
// Repository plugin files are arbitrary JavaScript executed in this process;
// until the process isolation boundary lands, loading them is opt-in per
// deployment. These flags are operator authority: they live in the deployment
// environment, which repository content cannot write. Mirrors the boolean
// parsing of allowUnconfiguredGitHubApp().

/** Repository-committed plugins (.gitwire/plugins/*.js) may load only when the deployment opts in. */
export function repoPluginsEnabled(env = process.env) {
  return /^(1|true|yes)$/i.test(String(env.GITWIRE_ENABLE_REPO_PLUGINS ?? ""));
}

/** The config playground may execute plugins[].source only when the deployment opts in. */
export function playgroundPluginsEnabled(env = process.env) {
  return /^(1|true|yes)$/i.test(String(env.GITWIRE_ENABLE_PLAYGROUND_PLUGINS ?? ""));
}
