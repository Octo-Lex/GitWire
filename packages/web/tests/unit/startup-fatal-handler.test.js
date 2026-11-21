// tests/unit/startup-fatal-handler.test.js
// Incident 2026-11-21 regression: an early main() rejection must be
// reported as itself — never masked by a secondary ReferenceError from a
// fatal handler referencing a logger existing only inside main(), never
// lost to an unserializable rejection, never truncated on piped stderr.

import { jest } from "@jest/globals";
import { readFileSync } from "node:fs";

const writeSyncMock = jest.fn(() => 1);
const exitSpy = jest.spyOn(process, "exit").mockImplementation((code) => {
  throw new Error(`process.exit:${code}`);
});

jest.unstable_mockModule("node:fs", () => ({
  writeSync: writeSyncMock,
}));

const { reportFatalStartupError } = await import("../../src/startupFatal.js");

beforeEach(() => {
  writeSyncMock.mockClear();
  exitSpy.mockClear();
});

afterAll(() => {
  exitSpy.mockRestore();
});

const lastPayload = () => JSON.parse(writeSyncMock.mock.calls[0][1]);

describe("reportFatalStartupError", () => {
  it("reports the ORIGINAL error (incident class: Redis AOF MISCONF) — not a ReferenceError about logger", () => {
    expect(() => reportFatalStartupError(new Error("MISCONF Errors writing to the AOF file: No space left on device")))
      .toThrow("process.exit:1");

    expect(writeSyncMock).toHaveBeenCalledTimes(1);
    expect(writeSyncMock.mock.calls[0][0]).toBe(2); // fd 2 — synchronous stderr
    const payload = lastPayload();
    expect(payload.msg).toBe("Fatal startup error");
    expect(payload.err.kind).toBe("Error");
    expect(payload.err.message).toContain("MISCONF Errors writing to the AOF file");
    expect(writeSyncMock.mock.calls[0][1]).not.toContain("logger is not defined");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("exactly one stderr write and one exit call — no double settlement", () => {
    expect(() => reportFatalStartupError(new TypeError("port in use"))).toThrow("process.exit:1");
    expect(writeSyncMock).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledTimes(1);
  });

  it("serializes string and plain-object rejections with one canonical shape", () => {
    expect(() => reportFatalStartupError("plain string failure")).toThrow("process.exit:1");
    expect(JSON.parse(writeSyncMock.mock.calls.at(-1)[1]).err).toEqual({ kind: "string", message: "plain string failure" });

    expect(() => reportFatalStartupError({ weird: true })).toThrow("process.exit:1");
    expect(JSON.parse(writeSyncMock.mock.calls.at(-1)[1]).err).toEqual({ kind: "object", raw: '{"weird":true}' });
  });

  it("NEVER THROWS on exotic rejections (circular, BigInt) — total serialization", () => {
    const circular = { self: null };
    circular.self = circular;
    expect(() => reportFatalStartupError(circular)).toThrow("process.exit:1");
    expect(JSON.parse(writeSyncMock.mock.calls[0][1]).err.kind).toBe("unserializable");

    writeSyncMock.mockClear();
    expect(() => reportFatalStartupError(10n)).toThrow("process.exit:1");
    expect(JSON.parse(writeSyncMock.mock.calls[0][1]).err.kind).toBe("unserializable");
  });

  it("index.js wiring pinned: main().catch uses the handler; the old logger-referencing catch is gone", () => {
    const src = readFileSync(new URL("../../src/index.js", import.meta.url), "utf8");
    expect(src).toContain("main().catch(reportFatalStartupError);");
    expect(src).not.toMatch(/main\(\)\.catch\(\(err\) => \{\s*logger\.error/);
  });
});
