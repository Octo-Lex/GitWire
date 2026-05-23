// @gitwire/rules — tests/plugins.test.js
// Tests for the plugin system.

import { loadPluginFromSource, loadPlugins, findPluginFiles } from "../src/plugins/loader.js";
import { createSandbox, getBlockedGlobals } from "../src/plugins/sandbox.js";

describe("createSandbox", () => {
  test("has safe globals", () => {
    const sandbox = createSandbox();
    expect(sandbox.JSON).toBe(JSON);
    expect(sandbox.Math).toBe(Math);
    expect(sandbox.Array).toBe(Array);
    expect(sandbox.String).toBe(String);
  });

  test("does not have dangerous globals", () => {
    const sandbox = createSandbox();
    expect(sandbox.require).toBeUndefined();
    expect(sandbox.process).toBeUndefined();
    expect(sandbox.fetch).toBeUndefined();
    expect(sandbox.setTimeout).toBeUndefined();
  });
});

describe("getBlockedGlobals", () => {
  test("returns array of blocked global names", () => {
    const blocked = getBlockedGlobals();
    expect(blocked).toContain("require");
    expect(blocked).toContain("process");
    expect(blocked).toContain("fetch");
    expect(blocked).toContain("setTimeout");
  });
});

describe("loadPluginFromSource", () => {
  test("loads CJS-style plugin with module.exports", () => {
    const source = `
      module.exports.inTeam = function(author, team) {
        return author === "alice" && team === "frontend";
      };
    `;
    const filters = loadPluginFromSource(source, "team.js");
    expect(filters.inTeam).toBeDefined();
    expect(typeof filters.inTeam).toBe("function");
    expect(filters.inTeam("alice", "frontend")).toBe(true);
    expect(filters.inTeam("bob", "frontend")).toBe(false);
  });

  test("returns empty object for source with no exports", () => {
    const source = "// no exports";
    const filters = loadPluginFromSource(source, "empty.js");
    expect(Object.keys(filters)).toHaveLength(0);
  });

  test("only extracts functions, not other types", () => {
    const source = `
      module.exports.fn = function() { return true; };
      module.exports.str = "hello";
      module.exports.num = 42;
    `;
    const filters = loadPluginFromSource(source, "mixed.js");
    expect(Object.keys(filters)).toEqual(["fn"]);
  });

  test("throws descriptive error for invalid source", () => {
    expect(() => loadPluginFromSource("}}invalid{{", "bad.js")).toThrow("Failed to load plugin");
  });
});

describe("loadPlugins", () => {
  test("merges multiple plugin sources", () => {
    const plugins = [
      {
        source: "module.exports.filterA = function(x) { return x > 0; };",
        filename: "a.js",
      },
      {
        source: "module.exports.filterB = function(x) { return x < 0; };",
        filename: "b.js",
      },
    ];
    const filters = loadPlugins(plugins);
    expect(filters.filterA).toBeDefined();
    expect(filters.filterB).toBeDefined();
    expect(filters.filterA(5)).toBe(true);
    expect(filters.filterB(-5)).toBe(true);
  });

  test("skips failed plugins without blocking others", () => {
    const plugins = [
      {
        source: "}}invalid{{",
        filename: "bad.js",
      },
      {
        source: "module.exports.good = function() { return true; };",
        filename: "good.js",
      },
    ];
    const filters = loadPlugins(plugins);
    expect(filters.good).toBeDefined();
    expect(filters.good()).toBe(true);
  });

  test("returns empty object for empty array", () => {
    const filters = loadPlugins([]);
    expect(Object.keys(filters)).toHaveLength(0);
  });
});

describe("findPluginFiles", () => {
  test("finds .js files in .gitwire/plugins/", () => {
    const tree = [
      { path: ".gitwire/plugins/custom.js", type: "blob" },
      { path: ".gitwire/plugins/filters.js", type: "blob" },
      { path: ".gitwire/config.yml", type: "blob" },
      { path: "src/app.js", type: "blob" },
      { path: ".gitwire/plugins/README.md", type: "blob" },
    ];
    const files = findPluginFiles(tree);
    expect(files).toHaveLength(2);
    expect(files[0].filename).toBe("custom.js");
    expect(files[1].filename).toBe("filters.js");
  });

  test("returns empty array for empty tree", () => {
    expect(findPluginFiles([])).toEqual([]);
    expect(findPluginFiles(null)).toEqual([]);
    expect(findPluginFiles(undefined)).toEqual([]);
  });

  test("ignores non-blob entries (trees)", () => {
    const tree = [
      { path: ".gitwire/plugins/sub/", type: "tree" },
      { path: ".gitwire/plugins/ok.js", type: "blob" },
    ];
    const files = findPluginFiles(tree);
    expect(files).toHaveLength(1);
    expect(files[0].filename).toBe("ok.js");
  });
});
