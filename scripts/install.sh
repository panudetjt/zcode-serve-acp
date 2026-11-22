#!/usr/bin/env bash
# Build, install, back up, and restore the single-file bridge binary.
#
# Usage:
#   scripts/install.sh [--dest PATH] [--restart] [--verify]
#   scripts/install.sh --restore [NAME|latest] [--dest PATH] [--restart]
#                      [--verify]
#   scripts/install.sh --list-backups [--dest PATH]
#   scripts/install.sh --global-agents
#   scripts/install.sh --remove-global-agents
#
# Flags:
#   --dest PATH       install target (default: <repo>/dist/zcode-serve-acp)
#   --restart         stop processes still running the replaced binary
#                     (SIGTERM, then SIGKILL after 5s)
#   --verify          run scripts/smoke.mjs against the installed binary
#                     (needs a ready `zcode serve` daemon)
#   --list-backups    list saved binaries next to the target and exit
#   --restore [NAME]  restore a backup (default: latest install backup);
#                     NAME is a bare backup filename or a path
#   --global-agents   add the T3 toolset-naming note to the daemon's global
#                     agent instructions ($HOME/.zcode/AGENTS.md) and exit.
#                     Idempotent; the note teaches every session on this
#                     machine (all projects) that T3 tools surface as
#                     mcp__t3-code__<name>. No build, no daemon contact.
#   --remove-global-agents
#                     remove that managed note again and exit
#
# Every install backs up the current binary as
#   backups/<name>.<UTC timestamp>.<sha256[0:12]>
# A restore backs up what it replaces as ...<sha>.safety; safety copies are
# excluded from the default "latest" pick, so a second restore does not
# reinstall the just-replaced binary. Pass a .safety name explicitly to
# restore one.
#
# Examples:
#   scripts/install.sh
#   scripts/install.sh --restart --verify
#   scripts/install.sh --list-backups
#   scripts/install.sh --dest ~/work/zcode-serve-acp/dist/zcode-serve-acp
#   scripts/install.sh --restore latest --restart
#   scripts/install.sh --global-agents
set -euo pipefail

repo=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
readonly repo
dest="$repo/dist/zcode-serve-acp"
mode=install
restore_name=""
do_restart=0
do_verify=0
base=""
bakdir=""
restore_src=""
tmp_file=""
pids_found=()

readonly GLOBAL_AGENTS_BEGIN="<!-- zcode-serve-acp:begin (managed by scripts/install.sh) -->"
readonly GLOBAL_AGENTS_END="<!-- zcode-serve-acp:end -->"

#######################################
# Print the managed global-agents note body (markers excluded).
# Outputs:
#   The note text to stdout.
# Returns:
#   0
#######################################
global_agents_body() {
  cat <<'EOF'
## T3 Code toolset naming (auto-added by zcode-serve-acp)

If the conversation includes a `<t3_code_instructions>` block: the tools it
names bare (`delegate_task`, `t3_thread_*`, `pull_request_*`, `preview_*`,
`html_render`, `request_secret`, ...) appear in the function list with an
`mcp__t3-code__` prefix. Call the prefixed name (`delegate_task` ->
`mcp__t3-code__delegate_task`). Never conclude the toolset is missing because
the bare names are absent from the function list, and do not use shell env
vars as a presence signal.
EOF
}

#######################################
# Print this file's header as usage text.
# Globals:
#   BASH_SOURCE
# Arguments:
#   None
# Outputs:
#   Writes usage to stdout.
# Returns:
#   0
#######################################
usage() {
  sed -n '2,/^set -euo/{/^set -euo/d;s/^# \{0,1\}//;p}' "${BASH_SOURCE[0]}"
}

#######################################
# Print an error and exit non-zero.
# Arguments:
#   Message to print.
# Outputs:
#   Writes to stderr.
# Returns:
#   Never returns (exit 1).
#######################################
die() {
  echo "install: $*" >&2
  exit 1
}

#######################################
# Parse command-line flags into globals.
# Globals:
#   dest, mode, restore_name, do_restart, do_verify
# Arguments:
#   Script arguments.
# Outputs:
#   Usage on --help; errors on stderr.
# Returns:
#   0, or exits on bad input.
#######################################
parse_args() {
  while (($#)); do
    case "$1" in
      --dest)
        (($# >= 2)) || die "--dest needs a path"
        dest=$2
        shift 2
        ;;
      --restart)
        do_restart=1
        shift
        ;;
      --verify)
        do_verify=1
        shift
        ;;
      --list-backups)
        mode=list
        shift
        ;;
      --global-agents)
        mode=global-agents
        shift
        ;;
      --remove-global-agents)
        mode=remove-global-agents
        shift
        ;;
      --restore)
        mode=restore
        shift
        if (($#)) && [[ ${1#-} == "$1" ]]; then
          restore_name=$1
          shift
        fi
        ;;
      -h | --help)
        usage
        exit 0
        ;;
      *)
        die "unknown argument: $1 (try --help)"
        ;;
    esac
  done
}

#######################################
# Resolve target paths to absolute form.
# Globals:
#   dest, base, bakdir
# Arguments:
#   None
# Outputs:
#   None
# Returns:
#   0
#######################################
init_paths() {
  dest=$(realpath -m -- "$dest")
  if [[ -d $dest ]]; then
    dest="$dest/zcode-serve-acp"
  fi
  base=$(basename "$dest")
  bakdir="$(dirname "$dest")/backups"
}

#######################################
# List saved binaries next to the target.
# Globals:
#   bakdir
# Arguments:
#   None
# Outputs:
#   One line per backup on stdout.
# Returns:
#   0
#######################################
list_backups() {
  local f first=1
  if [[ ! -d $bakdir ]]; then
    echo "install: no backups directory at $bakdir" >&2
    return 0
  fi
  for f in "$bakdir"/*; do
    [[ -e $f ]] || continue
    if ((first)); then
      echo "install: backups in $bakdir"
      first=0
    fi
    printf '  %s  %6s  %s\n' "$(basename "$f")" \
      "$(du -h "$f" | cut -f1)" "$(date -r "$f" '+%Y-%m-%d %H:%M')"
  done
  if ((first)); then
    echo "install: no backups in $bakdir" >&2
  fi
}

#######################################
# Collect PIDs started from the install target.
# Globals:
#   dest, pids_found
# Arguments:
#   None
# Outputs:
#   None
# Returns:
#   0
#######################################
collect_running_pids() {
  local p pid arg0
  pids_found=()
  for p in /proc/[0-9]*; do
    pid=${p#/proc/}
    if [[ $pid == "$$" ]]; then
      continue
    fi
    arg0=""
    IFS= read -r -d '' arg0 <"$p/cmdline" 2>/dev/null || true
    if [[ $arg0 == "$dest" || $p/exe -ef $dest ]]; then
      pids_found+=("$pid")
    fi
  done
}

#######################################
# Report whether a PID is alive (zombies are gone).
# Arguments:
#   PID to check.
# Outputs:
#   None
# Returns:
#   0 when alive and not a zombie.
#######################################
pid_alive() {
  local stat
  if [[ ! -r /proc/$1/stat ]]; then
    return 1
  fi
  stat=$(cat "/proc/$1/stat" 2>/dev/null) || return 1
  # Strip "pid (comm) " so the first field is the process state.
  stat=${stat##*) }
  [[ ${stat%% *} != Z ]]
}

#######################################
# Report whether any of the given PIDs is alive.
# Arguments:
#   PIDs to check.
# Outputs:
#   None
# Returns:
#   0 when at least one PID is alive.
#######################################
any_alive() {
  local pid
  for pid in "$@"; do
    if pid_alive "$pid"; then
      return 0
    fi
  done
  return 1
}

#######################################
# Wait for PIDs to exit, killing survivors.
# Arguments:
#   PIDs to wait for.
# Outputs:
#   Writes a SIGKILL notice to stderr.
# Returns:
#   0 when all PIDs are gone, 1 when any survive SIGKILL.
#######################################
wait_gone() {
  local i
  for ((i = 0; i < 25; i++)); do
    if ! any_alive "$@"; then
      return 0
    fi
    sleep 0.2
  done
  echo "install: still alive after SIGTERM: $* - sending SIGKILL" >&2
  kill -KILL "$@" 2>/dev/null || true
  for ((i = 0; i < 25; i++)); do
    if ! any_alive "$@"; then
      return 0
    fi
    sleep 0.2
  done
  return 1
}

#######################################
# Back up the current target before replacing it.
# Globals:
#   dest, bakdir, base
# Arguments:
#   Optional filename suffix (e.g. ".safety").
# Outputs:
#   Writes a "backup -> path" line to stdout.
# Returns:
#   0 (also when there is nothing to back up).
#######################################
backup_current() {
  local suffix=${1:-} sha backup
  if [[ ! -e $dest ]]; then
    return 0
  fi
  mkdir -p "$bakdir"
  sha=$(sha256sum "$dest" | cut -c1-12)
  backup="$bakdir/$base.$(date -u +%Y%m%dT%H%M%SZ).$sha$suffix"
  cp -p -- "$dest" "$backup"
  echo "install: backup -> $backup"
}

#######################################
# Build the bridge to a given path via the mise task.
# Globals:
#   repo
# Arguments:
#   Output path.
# Outputs:
#   Build progress on stderr/stdout.
# Returns:
#   0 on success.
#######################################
build_to() {
  local out=$1
  command -v mise >/dev/null 2>&1 ||
    die "mise not found on PATH (run \`mise install\`)"
  echo "install: building from $repo"
  (cd "$repo" && OUTFILE="$out" mise run compile)
}

#######################################
# Resolve which backup to restore.
# Globals:
#   bakdir, base, restore_name, restore_src
# Arguments:
#   None
# Outputs:
#   None
# Returns:
#   0, or exits when no matching backup exists.
#######################################
resolve_restore_source() {
  if [[ -z $restore_name || $restore_name == latest ]]; then
    restore_name=$(find "$bakdir" -maxdepth 1 -type f \
      -name "$base.*" ! -name "*.safety" -printf '%f\n' 2>/dev/null |
      sort | tail -n 1 || true)
    if [[ -z $restore_name ]]; then
      die "no install backups in $bakdir (pass a .safety name explicitly)"
    fi
  fi
  if [[ -f $restore_name ]]; then
    restore_src=$restore_name
  elif [[ -f $bakdir/$restore_name ]]; then
    restore_src="$bakdir/$restore_name"
  else
    die "backup not found: $restore_name (see --list-backups)"
  fi
}

#######################################
# Stop instances that still run the replaced binary.
# Globals:
#   pids_found, do_restart
# Arguments:
#   None
# Outputs:
#   Restart status on stdout.
# Returns:
#   0, or 1 when a PID survives SIGKILL.
#######################################
cutover() {
  if ((${#pids_found[@]} == 0)); then
    if ((do_restart)); then
      echo "install: no running instances to restart"
    fi
    return 0
  fi
  if ((!do_restart)); then
    echo "install: note: old binary still running as pid(s)" \
      "${pids_found[*]}; rerun with --restart to cut over"
    return 0
  fi
  echo "install: restarting ${pids_found[*]}"
  kill -TERM "${pids_found[@]}" 2>/dev/null || true
  if wait_gone "${pids_found[@]}"; then
    echo "install: old instances stopped; the client respawns the bridge"
  else
    echo "install: warning: pid(s) ${pids_found[*]} survived SIGKILL" >&2
    return 1
  fi
}

#######################################
# Smoke-test the installed binary against the live daemon.
# Globals:
#   repo, dest
# Arguments:
#   None
# Outputs:
#   Smoke output on stdout/stderr.
# Returns:
#   0 on PASS (propagates smoke failures).
#######################################
run_verify() {
  echo "install: verifying against the live daemon"
  (cd "$repo" && bun scripts/smoke.mjs --bin "$dest")
}

#######################################
# Resolve the global agent-instructions file path.
# Globals:
#   HOME
# Outputs:
#   None (sets global_agents_file on success).
# Returns:
#   0, or exits when HOME is unset.
#######################################
init_global_agents_file() {
  if [[ -z ${HOME:-} ]]; then
    die "HOME is not set; cannot locate ~/.zcode/AGENTS.md"
  fi
  global_agents_file="$HOME/.zcode/AGENTS.md"
}

#######################################
# Add or refresh the managed note in the global agent-instructions file.
# Globals:
#   global_agents_file, GLOBAL_AGENTS_BEGIN, GLOBAL_AGENTS_END
# Arguments:
#   None
# Outputs:
#   Status lines on stdout.
# Returns:
#   0 on success.
#######################################
write_global_agents() {
  mkdir -p "$(dirname "$global_agents_file")"
  tmp_file="$global_agents_file.tmp.$$"
  trap 'rm -f -- "$tmp_file"' EXIT
  if [[ ! -e $global_agents_file ]]; then
    { echo "$GLOBAL_AGENTS_BEGIN"; global_agents_body; echo "$GLOBAL_AGENTS_END"; } >"$tmp_file"
  elif grep -qF -- "$GLOBAL_AGENTS_BEGIN" "$global_agents_file"; then
    # Replace the existing block in place, preserving everything around it.
    awk -v begin="$GLOBAL_AGENTS_BEGIN" -v end="$GLOBAL_AGENTS_END" \
      -v blocksrc=<( { echo "$GLOBAL_AGENTS_BEGIN"; global_agents_body; echo "$GLOBAL_AGENTS_END"; } ) '
      BEGIN { while ((getline l < blocksrc) > 0) block[++n] = l }
      $0 == begin {
        inblock = 1
        if (!done) { for (i = 1; i <= n; i++) print block[i]; done = 1 }
        next
      }
      inblock && $0 == end { inblock = 0; next }
      inblock { next }
      { print }
      END { if (!done) { for (i = 1; i <= n; i++) print block[i] } }
    ' "$global_agents_file" >"$tmp_file"
  else
    # Fresh append: normalize the trailing newline, then attach the block.
    {
      cat -- "$global_agents_file"
      [[ $(tail -c1 -- "$global_agents_file") == $'\n' ]] || echo
      echo "$GLOBAL_AGENTS_BEGIN"
      global_agents_body
      echo "$GLOBAL_AGENTS_END"
    } >"$tmp_file"
  fi
  mv -f -- "$tmp_file" "$global_agents_file"
  trap - EXIT
  echo "install: wrote T3 toolset note -> $global_agents_file"
}

#######################################
# Remove the managed note from the global agent-instructions file.
# Globals:
#   global_agents_file, GLOBAL_AGENTS_BEGIN, GLOBAL_AGENTS_END
# Arguments:
#   None
# Outputs:
#   Status lines on stdout.
# Returns:
#   0 (also when the file or block is absent).
#######################################
remove_global_agents() {
  if [[ ! -e $global_agents_file ]] || ! grep -qF -- "$GLOBAL_AGENTS_BEGIN" "$global_agents_file"; then
    echo "install: no managed T3 toolset note in $global_agents_file"
    return 0
  fi
  tmp_file="$global_agents_file.tmp.$$"
  trap 'rm -f -- "$tmp_file"' EXIT
  awk -v begin="$GLOBAL_AGENTS_BEGIN" -v end="$GLOBAL_AGENTS_END" '
    $0 == begin { inblock = 1; next }
    inblock && $0 == end { inblock = 0; next }
    inblock { next }
    { print }
  ' "$global_agents_file" >"$tmp_file"
  mv -f -- "$tmp_file" "$global_agents_file"
  trap - EXIT
  echo "install: removed T3 toolset note -> $global_agents_file"
}

#######################################
# Entry point.
# Globals:
#   mode, dest, do_verify, tmp_file, restore_src
# Arguments:
#   Script arguments.
# Outputs:
#   Install/restore summary on stdout.
# Returns:
#   0 on success.
#######################################
main() {
  parse_args "$@"
  init_paths
  if [[ $mode == list ]]; then
    list_backups
    return 0
  fi
  if [[ $mode == global-agents || $mode == remove-global-agents ]]; then
    init_global_agents_file
    if [[ $mode == global-agents ]]; then
      write_global_agents
    else
      remove_global_agents
    fi
    return 0
  fi
  if ((do_verify)); then
    command -v bun >/dev/null 2>&1 ||
      die "bun not found on PATH (run \`mise install\`)"
  fi

  if [[ $mode == install ]]; then
    tmp_file="$dest.tmp.$$"
  else
    tmp_file="$dest.restore.$$"
  fi
  trap 'rm -f -- "$tmp_file"' EXIT

  if [[ $mode == install ]]; then
    build_to "$tmp_file"
  else
    resolve_restore_source
    cp -p -- "$restore_src" "$tmp_file"
  fi

  collect_running_pids
  local sha size
  if [[ $mode == install ]]; then
    backup_current
  else
    backup_current .safety
  fi

  chmod 0755 "$tmp_file"
  mv -f -- "$tmp_file" "$dest"
  trap - EXIT
  sha=$(sha256sum "$dest" | cut -c1-12)
  size=$(du -h "$dest" | cut -f1)
  if [[ $mode == install ]]; then
    echo "install: installed -> $dest ($sha, $size)"
  else
    echo "install: restored $(basename "$restore_src") ->" \
      "$dest ($sha, $size)"
  fi

  cutover
  if ((do_verify)); then
    run_verify
  fi
  echo "install: done"
}

main "$@"
