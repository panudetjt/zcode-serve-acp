import { describe, expect, test } from "bun:test";
import { Effect, Schema } from "effect";
import { FileSystem } from "effect/FileSystem";
import { ServerStatusSchema, dataRoot, resolveServeBinary, serverRoot } from "../src/serve/daemon.ts";

describe("Daemon discovery and resolution", () => {
  test("ServerStatusSchema validates daemon status JSON", () => {
    const valid = {
      state: "ready",
      host: "127.0.0.1",
      port: 54321,
      version: "3.18.2",
      pid: 12345,
    };
    const parsed = Schema.decodeUnknownSync(ServerStatusSchema)(valid);
    expect(parsed.state).toBe("ready");
    expect(parsed.host).toBe("127.0.0.1");
    expect(parsed.port).toBe(54321);
    expect(parsed.version).toBe("3.18.2");

    expect(() => Schema.decodeUnknownSync(ServerStatusSchema)({ state: "ready" })).toThrow();
  });

  test("dataRoot and serverRoot paths respect env overrides", () => {
    const originalData = process.env.ZCODE_DATA_BASE_DIR;
    const originalServer = process.env.ZCODE_SERVER_ROOT;
    try {
      delete process.env.ZCODE_DATA_BASE_DIR;
      delete process.env.ZCODE_SERVER_ROOT;
      const root = dataRoot();
      expect(typeof root).toBe("string");
      expect(serverRoot()).toContain(".zcode");

      process.env.ZCODE_DATA_BASE_DIR = "/custom/data";
      expect(dataRoot()).toBe("/custom/data");
      expect(serverRoot()).toBe("/custom/data/.zcode/server");

      process.env.ZCODE_SERVER_ROOT = "/explicit/server";
      expect(serverRoot()).toBe("/explicit/server");
    } finally {
      if (originalData !== undefined) process.env.ZCODE_DATA_BASE_DIR = originalData;
      else delete process.env.ZCODE_DATA_BASE_DIR;
      if (originalServer !== undefined) process.env.ZCODE_SERVER_ROOT = originalServer;
      else delete process.env.ZCODE_SERVER_ROOT;
    }
  });

  test("resolveServeBinary respects ZCODE_SERVE_BIN env var", async () => {
    const originalBin = process.env.ZCODE_SERVE_BIN;
    try {
      process.env.ZCODE_SERVE_BIN = "/opt/my-zcode";
      const fakeFs = {
        exists: () => Effect.succeed(false),
      } as unknown as FileSystem;
      const bin = await Effect.runPromise(resolveServeBinary(fakeFs));
      expect(bin).toBe("/opt/my-zcode");
    } finally {
      if (originalBin !== undefined) process.env.ZCODE_SERVE_BIN = originalBin;
      else delete process.env.ZCODE_SERVE_BIN;
    }
  });

  test("resolveServeBinary probes candidates via FileSystem", async () => {
    const originalBin = process.env.ZCODE_SERVE_BIN;
    try {
      delete process.env.ZCODE_SERVE_BIN;

      // When candidate exists
      const hitFs = {
        exists: (p: string) => Effect.succeed(p.includes(".zcode")),
      } as unknown as FileSystem;
      const bin = await Effect.runPromise(resolveServeBinary(hitFs));
      expect(bin).toContain(".zcode");

      // When no candidate exists, falls back to "zcode"
      const missFs = {
        exists: () => Effect.succeed(false),
      } as unknown as FileSystem;
      const fallback = await Effect.runPromise(resolveServeBinary(missFs));
      expect(fallback).toBe("zcode");
    } finally {
      if (originalBin !== undefined) process.env.ZCODE_SERVE_BIN = originalBin;
      else delete process.env.ZCODE_SERVE_BIN;
    }
  });
});
