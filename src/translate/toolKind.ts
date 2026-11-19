/**
 * Tool-row classification helpers — ported behavior-identical from the
 * pre-rewrite translator. The keyword lists come from observed daemon
 * `toolCall` row `toolName` values (runtime 3.18.2).
 */

/** ACP tool_call `kind` classification for the client's tool UI. */
export function classifyToolKind(toolName?: string): string {
  const t = (toolName ?? "").toLowerCase();
  if (
    t === "bash" ||
    t === "shell" ||
    t === "terminal" ||
    t === "exec" ||
    t === "execute" ||
    t === "execute_command" ||
    t === "run_command" ||
    t === "command"
  ) {
    return "execute";
  }
  if (t === "readfile" || t === "read_file" || t === "view_file" || t === "cat" || t === "read") {
    return "read";
  }
  if (
    t === "editfile" ||
    t === "write_file" ||
    t === "edit_file" ||
    t === "patch" ||
    t === "write" ||
    t === "replace_file_content" ||
    t === "append_file"
  ) {
    return "edit";
  }
  if (t === "grep" || t === "find" || t === "glob" || t === "search" || t === "search_web" || t === "rg") {
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
