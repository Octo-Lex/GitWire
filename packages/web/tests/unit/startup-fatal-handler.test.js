// tests/unit/startup-fatal-handler.test.js
// Incident 2026-11-21 regression: an early main() rejection must be
// reported as itself — never masked by a secondary ReferenceError from a
// fatal handler that references a logger existing only inside main().
//
// The handler lives in src/startupFatal.js (no runtime dependencies —
// importable without booting the worker graph); index.js wires it as
// main().catch(reportFatalStartupError), visible in the entry module.

import { jest } from "@jest/globals";
import { reportFatalStartupError } from "../../src/startupFatal.js";

const consoleSpy = jest.spyOn(console, "error").mockImplementation(() => {});
const exitSpy = jest.spyOn(process, "exit").mockImplementation((code) => {
  throw new Error(`process.exit:${code}`);
});

beforeEach(() => {
  consoleSpy.mockClear();
  exitSpy.mockClear();
});

afterAll(() => {
  consoleSpy.mockRestore();
  exitSpy.mockRestore();
});

describe("reportFatalStartupError", () => {
  it("reports the ORIGINAL error (incident class: Redis AOF MISCONF) — not a ReferenceError about logger", () => {
    expect(() => reportFatalStartupError(new Error("MISCONF Errors writing to the AOF file: No space left on device")))
      .toThrow("process.exit:1"); // reached exit; no other throw type seen

    expect(consoleSpy).toHaveBeenCalledTimes(1);
    const line = consoleSpy.mock.calls[0][0];
    expect(line).toContain("Fatal startup error");
    expect(line).toContain("MISCONF Errors writing to the AOF file"); // original survives
    expect(line).toContain("Error");                                   // name serialized
    expect(line).not.toContain("logger is not defined");               // the masking bug
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("exactly one stderr line and one exit call — no double settlement", () => {
    expect(() => reportFatalStartupError(new TypeError("port in use"))).toThrow("process.exit:1");
    expect(consoleSpy).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledTimes(1);
  });

  it("serializes string and non-Error rejections without throwing", () => {
    expect(() => reportFatalStartupError("plain string failure")).toThrow("process.exit:1");
    expect(consoleSpy.mock.calls[0][0]).toContain("plain string failure");
    expect(() => reportFatalStartupError({ weird: true })).toThrow("process.exit:1");
    expect(consoleSpy.mock.calls[1][0]).toContain("weird");
  });

  it("the wiring target exists and is the catch handler named in index.js", async () => {
    const indexSource = await import("node:fs").then((fs) =>
      fs.readFileSync(new URL("../../src/index.js", import.meta.url), "utf8"));
    expect(indexSource).toContain("main().catch(reportFatalStartupError);");
    expect(indexSource).not.toMatch(/main\(\)\.catch\(\(err\) => \{\s*logger\.error/);
  });
});
