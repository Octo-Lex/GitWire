// packages/core/src/buildInfo.js
// Committed fallback build-info module.
//
// This file is safe to import in any context: fresh clone, local dev, tests,
// CI, and Docker builds. The generator script (scripts/generate-build-info.js)
// can overwrite it with real version/SHA/built_at values during Docker/CI
// builds — but this committed fallback ensures imports never fail when the
// generator has not run.
//
// Version source-of-truth: root package.json. The generator reads it and
// writes the real value here. Until then, this fallback carries the current
// release version.

export const BUILD_INFO = Object.freeze({
  version: "0.23.1",
  git_sha: null,
  built_at: null,
  source: "fallback",
});

// Convenience export — VERSION is the most-used field and existing code
// imports { VERSION } from "@gitwire/core".
export const VERSION = BUILD_INFO.version;
