import { describe, expect, test } from "bun:test"
import { classifyToolKind, normalizeStatus } from "../src/translate/toolKind.ts"

describe("classifyToolKind", () => {
  test("classifies execution tools", () => {
    expect(classifyToolKind("bash")).toBe("execute")
    expect(classifyToolKind("Shell")).toBe("execute")
    expect(classifyToolKind("TERMINAL")).toBe("execute")
    expect(classifyToolKind("exec")).toBe("execute")
    expect(classifyToolKind("execute")).toBe("execute")
    expect(classifyToolKind("execute_command")).toBe("execute")
    expect(classifyToolKind("run_command")).toBe("execute")
    expect(classifyToolKind("command")).toBe("execute")
  })

  test("classifies read tools", () => {
    expect(classifyToolKind("readfile")).toBe("read")
    expect(classifyToolKind("read_file")).toBe("read")
    expect(classifyToolKind("view_file")).toBe("read")
    expect(classifyToolKind("cat")).toBe("read")
    expect(classifyToolKind("read")).toBe("read")
  })

  test("classifies edit tools", () => {
    expect(classifyToolKind("editfile")).toBe("edit")
    expect(classifyToolKind("write_file")).toBe("edit")
    expect(classifyToolKind("edit_file")).toBe("edit")
    expect(classifyToolKind("patch")).toBe("edit")
    expect(classifyToolKind("write")).toBe("edit")
    expect(classifyToolKind("replace_file_content")).toBe("edit")
    expect(classifyToolKind("append_file")).toBe("edit")
  })

  test("classifies search tools", () => {
    expect(classifyToolKind("grep")).toBe("search")
    expect(classifyToolKind("find")).toBe("search")
    expect(classifyToolKind("glob")).toBe("search")
    expect(classifyToolKind("search")).toBe("search")
    expect(classifyToolKind("search_web")).toBe("search")
    expect(classifyToolKind("rg")).toBe("search")
  })

  test("classifies fetch tools", () => {
    expect(classifyToolKind("fetch")).toBe("fetch")
    expect(classifyToolKind("download")).toBe("fetch")
    expect(classifyToolKind("curl")).toBe("fetch")
    expect(classifyToolKind("http")).toBe("fetch")
    expect(classifyToolKind("preview_open")).toBe("fetch")
    expect(classifyToolKind("preview_navigate")).toBe("fetch")
    expect(classifyToolKind("browser")).toBe("fetch")
  })

  test("classifies delete tools", () => {
    expect(classifyToolKind("delete")).toBe("delete")
    expect(classifyToolKind("remove")).toBe("delete")
    expect(classifyToolKind("rm")).toBe("delete")
    expect(classifyToolKind("unlink")).toBe("delete")
    expect(classifyToolKind("delete_scheduled_task")).toBe("delete")
    expect(classifyToolKind("unlink_pull_request")).toBe("delete")
    expect(classifyToolKind("unlink_issue")).toBe("delete")
    expect(classifyToolKind("device_close")).toBe("delete")
    expect(classifyToolKind("t3_preview_close")).toBe("delete")
    expect(classifyToolKind("t3_project_delete")).toBe("delete")
    expect(classifyToolKind("task_cancel")).toBe("delete")
    expect(classifyToolKind("t3_workflow_stop")).toBe("delete")
  })

  test("classifies MCP tools and strips namespace prefix", () => {
    // Execution
    expect(classifyToolKind("preview_act")).toBe("execute")
    expect(classifyToolKind("preview_evaluate")).toBe("execute")
    expect(classifyToolKind("ci_rerun")).toBe("execute")
    expect(classifyToolKind("delegate_task")).toBe("execute")
    expect(classifyToolKind("run_scheduled_task_now")).toBe("execute")
    expect(classifyToolKind("t3_thread_interrupt")).toBe("execute")

    // Reading
    expect(classifyToolKind("preview_snapshot")).toBe("read")
    expect(classifyToolKind("preview_status")).toBe("read")
    expect(classifyToolKind("device_list")).toBe("read")
    expect(classifyToolKind("device_screenshot")).toBe("read")
    expect(classifyToolKind("read_issue")).toBe("read")
    expect(classifyToolKind("list_issues")).toBe("read")
    expect(classifyToolKind("ci_logs")).toBe("read")
    expect(classifyToolKind("t3_worktree_status")).toBe("read")
    expect(classifyToolKind("t3_thread_list")).toBe("read")
    expect(classifyToolKind("t3_thread_read")).toBe("read")
    expect(classifyToolKind("orchestrator_capabilities")).toBe("read")
    expect(classifyToolKind("task_status")).toBe("read")
    expect(classifyToolKind("list_scheduled_tasks")).toBe("read")
    expect(classifyToolKind("t3_thread_wait")).toBe("read")
    expect(classifyToolKind("t3_pending_request")).toBe("read")

    // Editing
    expect(classifyToolKind("t3_thread_update")).toBe("edit")
    expect(classifyToolKind("pull_request_update")).toBe("edit")
    expect(classifyToolKind("pull_request_create")).toBe("edit")
    expect(classifyToolKind("pull_request_respond")).toBe("edit")
    expect(classifyToolKind("pull_request_review")).toBe("edit")
    expect(classifyToolKind("pull_request_merge")).toBe("edit")
    expect(classifyToolKind("comment_on_issue")).toBe("edit")
    expect(classifyToolKind("create_issue")).toBe("edit")
    expect(classifyToolKind("set_issue_state")).toBe("edit")
    expect(classifyToolKind("link_issue")).toBe("edit")
    expect(classifyToolKind("link_pull_request")).toBe("edit")
    expect(classifyToolKind("t3_project_create")).toBe("edit")
    expect(classifyToolKind("t3_theme_set")).toBe("edit")
    expect(classifyToolKind("t3_thread_launch")).toBe("edit")
    expect(classifyToolKind("create_threads")).toBe("edit")
    expect(classifyToolKind("t3_thread_send")).toBe("edit")
    expect(classifyToolKind("t3_thread_configure")).toBe("edit")
    expect(classifyToolKind("request_secret")).toBe("edit")
    expect(classifyToolKind("device_open")).toBe("edit")

    // Other (mockup/rendering)
    expect(classifyToolKind("html_render")).toBe("other")
    expect(classifyToolKind("html_preview")).toBe("other")

    // Stripping mcp__ prefix (single and multi-level namespace)
    expect(classifyToolKind("mcp__t3_code__preview_open")).toBe("fetch")
    expect(classifyToolKind("mcp__t3_code__preview_snapshot")).toBe("read")
    expect(classifyToolKind("mcp__t3_code__preview_act")).toBe("execute")
    expect(classifyToolKind("mcp__t3_code__create_issue")).toBe("edit")
    expect(classifyToolKind("mcp__t3_code__device_close")).toBe("delete")
    expect(classifyToolKind("mcp__t3_code__html_render")).toBe("other")
    expect(classifyToolKind("mcp__read_file")).toBe("read")
    expect(classifyToolKind("mcp__preview_open")).toBe("fetch")
    expect(classifyToolKind("mcp__bash")).toBe("execute")
    expect(classifyToolKind("mcp__create_issue")).toBe("edit")
    expect(classifyToolKind("mcp__delete_scheduled_task")).toBe("delete")

    // Heuristics
    expect(classifyToolKind("read_custom_data")).toBe("read")
    expect(classifyToolKind("list_custom_items")).toBe("read")
    expect(classifyToolKind("view_custom_doc")).toBe("read")
    expect(classifyToolKind("write_custom_data")).toBe("edit")
    expect(classifyToolKind("update_custom_state")).toBe("edit")
    expect(classifyToolKind("delete_custom_data")).toBe("delete")
    expect(classifyToolKind("search_custom_index")).toBe("search")
  })

  test("classifies unknown or undefined as other", () => {
    expect(classifyToolKind("custom_tool")).toBe("other")
    expect(classifyToolKind(undefined)).toBe("other")
  })
})

describe("normalizeStatus", () => {
  test("normalizes completed statuses", () => {
    expect(normalizeStatus("complete")).toBe("completed")
    expect(normalizeStatus("completed")).toBe("completed")
    expect(normalizeStatus("done")).toBe("completed")
    expect(normalizeStatus("success")).toBe("completed")
  })

  test("normalizes failed statuses", () => {
    expect(normalizeStatus("failed")).toBe("failed")
    expect(normalizeStatus("error")).toBe("failed")
    expect(normalizeStatus("cancelled")).toBe("failed")
    expect(normalizeStatus("interrupted")).toBe("failed")
  })

  test("normalizes pending statuses", () => {
    expect(normalizeStatus("pending")).toBe("pending")
    expect(normalizeStatus("waiting")).toBe("pending")
    expect(normalizeStatus("inputstreaming")).toBe("pending")
    expect(normalizeStatus("pendingapproval")).toBe("pending")
  })

  test("normalizes unknown or running statuses to in_progress", () => {
    expect(normalizeStatus("running")).toBe("in_progress")
    expect(normalizeStatus(undefined)).toBe("in_progress")
  })
})
