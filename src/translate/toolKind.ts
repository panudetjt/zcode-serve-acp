/**
 * Tool-row classification helpers — ported behavior-identical from the
 * pre-rewrite translator. The keyword lists come from observed daemon
 * `toolCall` row `toolName` values (runtime 3.18.2).
 */

/** ACP tool_call `kind` classification for the client's tool UI. */
export function classifyToolKind(toolName?: string): string {
  const raw = (toolName ?? "").toLowerCase();
  // Strip MCP namespace prefix if present (e.g. "mcp__t3_code__preview_open" -> "preview_open", "mcp__read_file" -> "read_file")
  let t = raw;
  if (t.startsWith("mcp__")) {
    const secondSep = t.indexOf("__", 5);
    t = secondSep !== -1 ? t.slice(secondSep + 2) : t.slice(5);
  }

  if (
    t === "bash" ||
    t === "shell" ||
    t === "terminal" ||
    t === "exec" ||
    t === "execute" ||
    t === "execute_command" ||
    t === "run_command" ||
    t === "command" ||
    t === "preview_act" ||
    t === "preview_evaluate" ||
    t === "ci_rerun" ||
    t === "delegate_task" ||
    t === "run_scheduled_task_now" ||
    t === "t3_thread_interrupt"
  ) {
    return "execute";
  }
  if (
    t === "readfile" ||
    t === "read_file" ||
    t === "view_file" ||
    t === "cat" ||
    t === "read" ||
    t === "read_resource" ||
    t === "list_resources" ||
    t === "read_issue" ||
    t === "list_issues" ||
    t === "list_thread_issues" ||
    t === "read_pull_request_guide" ||
    t === "pull_request_read" ||
    t === "pull_request_list" ||
    t === "list_thread_pull_requests" ||
    t === "ci_logs" ||
    t === "device_list" ||
    t === "device_screenshot" ||
    t === "preview_snapshot" ||
    t === "preview_status" ||
    t === "t3_worktree_status" ||
    t === "t3_worktree_list" ||
    t === "t3_thread_list" ||
    t === "t3_thread_read" ||
    t === "t3_thread_search" ||
    t === "t3_project_list" ||
    t === "t3_project_read" ||
    t === "t3_theme_read" ||
    t === "t3_environment_read" ||
    t === "t3_preview_list" ||
    t === "orchestrator_capabilities" ||
    t === "task_status" ||
    t === "list_scheduled_tasks" ||
    t === "t3_thread_wait" ||
    t === "t3_pending_request"
  ) {
    return "read";
  }
  if (
    t === "editfile" ||
    t === "write_file" ||
    t === "edit_file" ||
    t === "patch" ||
    t === "write" ||
    t === "replace_file_content" ||
    t === "append_file" ||
    t === "create_file" ||
    t === "t3_thread_update" ||
    t === "pull_request_update" ||
    t === "pull_request_create" ||
    t === "pull_request_respond" ||
    t === "pull_request_review" ||
    t === "pull_request_merge" ||
    t === "comment_on_issue" ||
    t === "create_issue" ||
    t === "set_issue_state" ||
    t === "link_issue" ||
    t === "link_pull_request" ||
    t === "link_pull_requests" ||
    t === "t3_project_create" ||
    t === "t3_project_update" ||
    t === "t3_theme_set" ||
    t === "t3_environment_preferences_update" ||
    t === "t3_thread_launch" ||
    t === "create_threads" ||
    t === "t3_thread_send" ||
    t === "t3_thread_configure" ||
    t === "t3_thread_transfer" ||
    t === "t3_thread_organize" ||
    t === "t3_thread_send_attachments" ||
    t === "request_secret" ||
    t === "device_open"
  ) {
    return "edit";
  }
  if (
    t === "delete" ||
    t === "remove" ||
    t === "rm" ||
    t === "unlink" ||
    t === "delete_scheduled_task" ||
    t === "unlink_pull_request" ||
    t === "unlink_pull_requests" ||
    t === "unlink_issue" ||
    t === "device_close" ||
    t === "t3_preview_close" ||
    t === "t3_attachment_discard" ||
    t === "t3_project_delete" ||
    t === "task_cancel" ||
    t === "t3_workflow_stop"
  ) {
    return "delete";
  }
  if (t === "grep" || t === "find" || t === "glob" || t === "search" || t === "search_web" || t === "rg") {
    return "search";
  }
  if (
    t === "fetch" ||
    t === "download" ||
    t === "curl" ||
    t === "http" ||
    t === "preview_open" ||
    t === "preview_navigate" ||
    t === "browser"
  ) {
    return "fetch";
  }
  if (t.startsWith("read_") || t.startsWith("list_") || t.startsWith("view_")) {
    return "read";
  }
  if (
    t.startsWith("write_") ||
    t.startsWith("edit_") ||
    t.startsWith("patch_") ||
    t.startsWith("update_") ||
    t.startsWith("create_") ||
    t.startsWith("modify_") ||
    t.startsWith("append_") ||
    t.startsWith("set_")
  ) {
    return "edit";
  }
  if (t.startsWith("delete_") || t.startsWith("remove_") || t.startsWith("unlink_")) {
    return "delete";
  }
  if (t.startsWith("search_") || t.startsWith("find_")) {
    return "search";
  }
  return "other";
}

/** Map a daemon row `status`/`state` string to the ACP tool status set. */
export function normalizeStatus(state: string | undefined): string {
  const s = (state ?? "").toLowerCase();
  if (s === "complete" || s === "completed" || s === "done" || s === "success") return "completed";
  if (s === "failed" || s === "error" || s.includes("fail") || s.includes("cancel") || s.includes("interrupt")) {
    return "failed";
  }
  if (s === "pending" || s.includes("wait") || s === "inputstreaming" || s === "pendingapproval") return "pending";
  return "in_progress";
}
