import { describe, expect, test } from "bun:test";
import { classifyToolKind, normalizeStatus } from "../src/translate/toolKind.ts";

describe("classifyToolKind", () => {
  test("classifies execution tools", () => {
    expect(classifyToolKind("bash")).toBe("execute");
    expect(classifyToolKind("Shell")).toBe("execute");
    expect(classifyToolKind("TERMINAL")).toBe("execute");
    expect(classifyToolKind("exec")).toBe("execute");
    expect(classifyToolKind("execute")).toBe("execute");
    expect(classifyToolKind("execute_command")).toBe("execute");
    expect(classifyToolKind("run_command")).toBe("execute");
    expect(classifyToolKind("command")).toBe("execute");
  });

  test("classifies read tools", () => {
    expect(classifyToolKind("readfile")).toBe("read");
    expect(classifyToolKind("read_file")).toBe("read");
    expect(classifyToolKind("view_file")).toBe("read");
    expect(classifyToolKind("cat")).toBe("read");
    expect(classifyToolKind("read")).toBe("read");
  });

  test("classifies edit tools", () => {
    expect(classifyToolKind("editfile")).toBe("edit");
    expect(classifyToolKind("write_file")).toBe("edit");
    expect(classifyToolKind("edit_file")).toBe("edit");
    expect(classifyToolKind("patch")).toBe("edit");
    expect(classifyToolKind("write")).toBe("edit");
    expect(classifyToolKind("replace_file_content")).toBe("edit");
    expect(classifyToolKind("append_file")).toBe("edit");
  });

  test("classifies search tools", () => {
    expect(classifyToolKind("grep")).toBe("search");
    expect(classifyToolKind("find")).toBe("search");
    expect(classifyToolKind("glob")).toBe("search");
    expect(classifyToolKind("search")).toBe("search");
    expect(classifyToolKind("search_web")).toBe("search");
    expect(classifyToolKind("rg")).toBe("search");
  });

  test("classifies unknown or undefined as other", () => {
    expect(classifyToolKind("custom_tool")).toBe("other");
    expect(classifyToolKind(undefined)).toBe("other");
  });
});

describe("normalizeStatus", () => {
  test("normalizes completed statuses", () => {
    expect(normalizeStatus("complete")).toBe("completed");
    expect(normalizeStatus("completed")).toBe("completed");
    expect(normalizeStatus("done")).toBe("completed");
    expect(normalizeStatus("success")).toBe("completed");
  });

  test("normalizes failed statuses", () => {
    expect(normalizeStatus("failed")).toBe("failed");
    expect(normalizeStatus("error")).toBe("failed");
    expect(normalizeStatus("cancelled")).toBe("failed");
    expect(normalizeStatus("interrupted")).toBe("failed");
  });

  test("normalizes pending statuses", () => {
    expect(normalizeStatus("pending")).toBe("pending");
    expect(normalizeStatus("waiting")).toBe("pending");
    expect(normalizeStatus("inputstreaming")).toBe("pending");
    expect(normalizeStatus("pendingapproval")).toBe("pending");
  });

  test("normalizes unknown or running statuses to in_progress", () => {
    expect(normalizeStatus("running")).toBe("in_progress");
    expect(normalizeStatus(undefined)).toBe("in_progress");
  });
});
