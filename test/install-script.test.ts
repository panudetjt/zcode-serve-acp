import { afterEach, describe, expect, test } from "bun:test"
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

const repo = path.resolve(import.meta.dir, "..")
const script = path.join(repo, "scripts", "install.sh")
const SMOKE = path.join(repo, "scripts", "smoke.mjs")

const dirs: string[] = []

function scratch(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "zcode-install-"))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function run(args: string[], cwd = repo) {
  const proc = Bun.spawnSync([script, ...args], { cwd, stdout: "pipe", stderr: "pipe" })
  return { code: proc.exitCode ?? -1, out: proc.stdout.toString(), err: proc.stderr.toString() }
}

function runEnv(args: string[], env: Record<string, string>, cwd = repo) {
  const proc = Bun.spawnSync([script, ...args], {
    cwd,
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe"
  })
  return { code: proc.exitCode ?? -1, out: proc.stdout.toString(), err: proc.stderr.toString() }
}

// Run the script in a shell whose kill/sleep are no-ops, simulating signals
// that do not reach the target (EPERM / uninterruptible sleep). Sourcing keeps
// the overrides in the same shell; BASH_ENV is not reliable across runners.
function runWithoutSignals(args: string[], cwd = repo) {
  const wrapper = 'kill() { :; }; sleep() { :; }; source "$1" "${@:2}"'
  const proc = Bun.spawnSync(["bash", "-c", wrapper, "_", script, ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe"
  })
  return { code: proc.exitCode ?? -1, out: proc.stdout.toString(), err: proc.stderr.toString() }
}

// Wait until the spawned process is visible in /proc with an argv[0]; on slow
// runners the first 100ms can elapse before the exec completes.
async function waitForProcess(pid: number, attempts = 100): Promise<void> {
  let started = false
  try {
    started = readFileSync(`/proc/${pid}/cmdline`).length > 0
  } catch {
    started = false
  }
  if (started) return
  if (attempts <= 0) throw new Error(`process ${pid} did not start`)
  await Bun.sleep(10)
  return waitForProcess(pid, attempts - 1)
}

const OLD = "zcode-serve-acp.20260101T000000Z.aaaaaaaaaaaa"
const NEW = "zcode-serve-acp.20260102T000000Z.bbbbbbbbbbbb"
const SAFETY = "zcode-serve-acp.20260103T000000Z.cccccccccccc.safety"

function seed() {
  const dir = scratch()
  const dest = path.join(dir, "zcode-serve-acp")
  const backups = path.join(dir, "backups")
  mkdirSync(backups, { recursive: true })
  writeFileSync(dest, "current")
  writeFileSync(path.join(backups, OLD), "backup-old")
  writeFileSync(path.join(backups, NEW), "backup-new")
  writeFileSync(path.join(backups, SAFETY), "backup-safety")
  return { dir, dest, backups }
}

function safetyCopies(backups: string): string[] {
  return readdirSync(backups).filter((f) => f.endsWith(".safety") && f !== SAFETY)
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

describe("install.sh", () => {
  test("--list-backups resolves a relative --dest against the cwd", () => {
    const { dir } = seed()
    const result = run(["--list-backups", "--dest", "zcode-serve-acp"], dir)
    expect(result.code).toBe(0)
    expect(result.out).toContain(OLD)
    expect(result.out).toContain(SAFETY)
  })

  test("--restore latest skips .safety and backs up what it replaces", () => {
    const { dest, backups } = seed()
    const result = run(["--restore", "--dest", dest])
    expect(result.code).toBe(0)
    expect(readFileSync(dest, "utf8")).toBe("backup-new")
    const created = safetyCopies(backups)
    expect(created).toHaveLength(1)
    expect(readFileSync(path.join(backups, created[0]!), "utf8")).toBe("current")
  })

  test("a second --restore still picks the newest install backup, not the safety copy", () => {
    const { dest, backups } = seed()
    expect(run(["--restore", "--dest", dest]).code).toBe(0)
    expect(run(["--restore", "--dest", dest]).code).toBe(0)
    expect(readFileSync(dest, "utf8")).toBe("backup-new")
    expect(safetyCopies(backups)).toHaveLength(2)
  })

  test("--restore NAME restores a specific backup", () => {
    const { dest } = seed()
    const result = run(["--restore", OLD, "--dest", dest])
    expect(result.code).toBe(0)
    expect(readFileSync(dest, "utf8")).toBe("backup-old")
  })

  test("--restore fails when the named backup does not exist", () => {
    const { dest } = seed()
    const result = run(["--restore", "missing", "--dest", dest])
    expect(result.code).not.toBe(0)
    expect(result.err).toContain("backup not found")
  })

  test("--restore refuses a safety-only backups directory", () => {
    const dir = scratch()
    const dest = path.join(dir, "zcode-serve-acp")
    const backups = path.join(dir, "backups")
    mkdirSync(backups, { recursive: true })
    writeFileSync(dest, "current")
    writeFileSync(path.join(backups, SAFETY), "backup-safety")
    const result = run(["--restore", "--dest", dest])
    expect(result.code).not.toBe(0)
    expect(result.err).toContain("no install backups")
  })

  test("--restart stops an instance started from the target path", async () => {
    const dir = scratch()
    const dest = path.join(dir, "zcode-serve-acp")
    const backups = path.join(dir, "backups")
    mkdirSync(backups, { recursive: true })
    const bashBin = Bun.which("bash")
    if (bashBin === null) throw new Error("bash not found")
    copyFileSync(bashBin, dest)
    chmodSync(dest, 0o755)
    writeFileSync(path.join(backups, OLD), "restored")

    const child = Bun.spawn([dest, "-c", "while :; do sleep 1; done"], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore"
    })
    try {
      await waitForProcess(child.pid)
      const result = run(["--restore", OLD, "--restart", "--dest", dest])
      expect(result.code).toBe(0)
      expect(readFileSync(dest, "utf8")).toBe("restored")
      await Bun.sleep(100)
      expect(isAlive(child.pid)).toBe(false)
    } finally {
      child.kill("SIGKILL")
    }
  })

  test("--restart matches an instance launched through a symlink", async () => {
    const dir = scratch()
    const dest = path.join(dir, "zcode-serve-acp")
    const link = path.join(dir, "zcode-serve-acp-link")
    const backups = path.join(dir, "backups")
    mkdirSync(backups, { recursive: true })
    const bashBin = Bun.which("bash")
    if (bashBin === null) throw new Error("bash not found")
    copyFileSync(bashBin, dest)
    chmodSync(dest, 0o755)
    symlinkSync(dest, link)
    writeFileSync(path.join(backups, OLD), "restored")

    const child = Bun.spawn([link, "-c", "while :; do sleep 1; done"], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore"
    })
    try {
      await waitForProcess(child.pid)
      const result = run(["--restore", OLD, "--restart", "--dest", dest])
      expect(result.code).toBe(0)
      expect(readFileSync(dest, "utf8")).toBe("restored")
      await Bun.sleep(100)
      expect(isAlive(child.pid)).toBe(false)
    } finally {
      child.kill("SIGKILL")
    }
  })

  test("--restart escalates to SIGKILL when SIGTERM is ignored", async () => {
    const dir = scratch()
    const dest = path.join(dir, "zcode-serve-acp")
    const backups = path.join(dir, "backups")
    mkdirSync(backups, { recursive: true })
    const bashBin = Bun.which("bash")
    if (bashBin === null) throw new Error("bash not found")
    copyFileSync(bashBin, dest)
    chmodSync(dest, 0o755)
    writeFileSync(path.join(backups, OLD), "restored")

    const child = Bun.spawn([dest, "-c", "trap '' TERM; while :; do sleep 1; done"], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore"
    })
    try {
      await waitForProcess(child.pid)
      const startedAt = performance.now()
      const result = run(["--restore", OLD, "--restart", "--dest", dest])
      expect(result.code).toBe(0)
      expect(performance.now() - startedAt).toBeGreaterThanOrEqual(4_000)
      expect(result.err).toContain("SIGKILL")
      await Bun.sleep(100)
      expect(isAlive(child.pid)).toBe(false)
    } finally {
      // SIGTERM is trapped by the stub by design — only SIGKILL guarantees
      // cleanup if an assertion above throws before the script's own SIGKILL.
      child.kill("SIGKILL")
    }
  }, 15_000)

  test("--restart reports failure when signals cannot stop the instance", async () => {
    const dir = scratch()
    const dest = path.join(dir, "zcode-serve-acp")
    const backups = path.join(dir, "backups")
    mkdirSync(backups, { recursive: true })
    const bashBin = Bun.which("bash")
    if (bashBin === null) throw new Error("bash not found")
    copyFileSync(bashBin, dest)
    chmodSync(dest, 0o755)
    writeFileSync(path.join(backups, OLD), "restored")

    const child = Bun.spawn([dest, "-c", "trap '' TERM; while :; do sleep 1; done"], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore"
    })
    try {
      await waitForProcess(child.pid)
      const result = runWithoutSignals(["--restore", OLD, "--restart", "--dest", dest])
      if (result.code !== 1) {
        throw new Error(`expected exit 1, got ${result.code}\nstdout:\n${result.out}\nstderr:\n${result.err}`)
      }
      expect(result.err).toContain("survived SIGKILL")
      expect(isAlive(child.pid)).toBe(true)
    } finally {
      // The stub traps SIGTERM and must stay alive through the script; only
      // SIGKILL here stops it — a plain kill() leaked a spinning process per run.
      child.kill("SIGKILL")
    }
  })

  test("install mode builds through mise, backs up, then replaces", () => {
    const dir = scratch()
    const dest = path.join(dir, "zcode-serve-acp")
    const backups = path.join(dir, "backups")
    const binDir = path.join(dir, "bin")
    mkdirSync(binDir, { recursive: true })
    writeFileSync(dest, "old-binary")

    // Fake mise: the compile task writes OUTFILE instead of building 105 MB.
    const mise = path.join(binDir, "mise")
    writeFileSync(
      mise,
      `#!/bin/sh
[ "$1" = run ] && [ "$2" = compile ] || exit 1
printf fake-binary > "$OUTFILE"
chmod +x "$OUTFILE"
`
    )
    chmodSync(mise, 0o755)

    const result = runEnv(["--dest", dest], {
      PATH: `${binDir}:${process.env.PATH ?? ""}`
    })
    expect(result.code).toBe(0)
    expect(readFileSync(dest, "utf8")).toBe("fake-binary")
    const saved = readdirSync(backups)
    expect(saved).toHaveLength(1)
    expect(readFileSync(path.join(backups, saved[0]!), "utf8")).toBe("old-binary")
    expect(result.out).toContain("backup ->")
    expect(result.out).toContain("installed ->")
  })

  test("--verify runs smoke through bun with the installed path", () => {
    const dir = scratch()
    const dest = path.join(dir, "zcode-serve-acp")
    const backups = path.join(dir, "backups")
    const binDir = path.join(dir, "bin")
    const record = path.join(dir, "argv")
    mkdirSync(backups, { recursive: true })
    mkdirSync(binDir, { recursive: true })
    writeFileSync(dest, "current")
    writeFileSync(path.join(backups, OLD), "restored")

    const bun = path.join(binDir, "bun")
    writeFileSync(
      bun,
      `#!/bin/sh
printf '%s\\n' "$*" > "$RECORD"
`
    )
    chmodSync(bun, 0o755)

    const result = runEnv(["--restore", OLD, "--verify", "--dest", dest], {
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
      RECORD: record
    })
    expect(result.code).toBe(0)
    expect(readFileSync(dest, "utf8")).toBe("restored")
    const argv = readFileSync(record, "utf8")
    expect(argv).toContain("scripts/smoke.mjs")
    expect(argv).toContain(`--bin ${dest}`)
  })

  test("smoke --bin fails fast when the path does not exist", () => {
    const missing = path.join(scratch(), "nope")
    const proc = Bun.spawnSync(["bun", SMOKE, "--bin", missing], {
      cwd: repo,
      stdout: "pipe",
      stderr: "pipe"
    })
    expect(proc.exitCode).toBe(2)
    expect(proc.stderr.toString()).toContain("--bin not found")
  })

  describe("--global-agents", () => {
    const BEGIN = "<!-- zcode-serve-acp:begin (managed by scripts/install.sh) -->"
    const END = "<!-- zcode-serve-acp:end -->"

    function agentsFile(home: string): string {
      return path.join(home, ".zcode", "AGENTS.md")
    }

    test("creates the file with the managed note when it does not exist", () => {
      const home = scratch()
      const result = runEnv(["--global-agents"], { HOME: home })
      expect(result.code).toBe(0)
      const content = readFileSync(agentsFile(home), "utf8")
      expect(content).toContain(BEGIN)
      expect(content).toContain(END)
      expect(content).toContain("mcp__t3-code__")
      expect(content.indexOf(BEGIN)).toBeLessThan(content.indexOf(END))
    })

    test("is idempotent — a second run does not duplicate the block", () => {
      const home = scratch()
      runEnv(["--global-agents"], { HOME: home })
      runEnv(["--global-agents"], { HOME: home })
      const content = readFileSync(agentsFile(home), "utf8")
      expect(content.split(BEGIN).length - 1).toBe(1)
      expect(content.split(END).length - 1).toBe(1)
    })

    test("refreshes a stale managed block without touching surrounding content", () => {
      const home = scratch()
      runEnv(["--global-agents"], { HOME: home })
      const file = agentsFile(home)
      const original = readFileSync(file, "utf8")
      writeFileSync(file, original.replace("mcp__t3-code__", "STALE-MARKER").replace(BEGIN, `${BEGIN}\nstale line`))
      const result = runEnv(["--global-agents"], { HOME: home })
      expect(result.code).toBe(0)
      const content = readFileSync(file, "utf8")
      expect(content).not.toContain("stale line")
      expect(content).toContain("mcp__t3-code__")
      expect(content.split(BEGIN).length - 1).toBe(1)
    })

    test("appends to existing user content and preserves it", () => {
      const home = scratch()
      const file = agentsFile(home)
      mkdirSync(path.dirname(file), { recursive: true })
      writeFileSync(file, "# My own global notes\n\nKeep this.\n")
      const result = runEnv(["--global-agents"], { HOME: home })
      expect(result.code).toBe(0)
      const content = readFileSync(file, "utf8")
      expect(content.startsWith("# My own global notes\n\nKeep this.\n")).toBe(true)
      expect(content).toContain(BEGIN)
    })

    test("appends after content that lacks a trailing newline", () => {
      const home = scratch()
      const file = agentsFile(home)
      mkdirSync(path.dirname(file), { recursive: true })
      writeFileSync(file, "no trailing newline")
      const result = runEnv(["--global-agents"], { HOME: home })
      expect(result.code).toBe(0)
      const content = readFileSync(file, "utf8")
      expect(content).toContain("no trailing newline\n")
      expect(content).toContain(BEGIN)
    })

    test("--remove-global-agents strips the block and keeps user content", () => {
      const home = scratch()
      const file = agentsFile(home)
      mkdirSync(path.dirname(file), { recursive: true })
      writeFileSync(file, "# Mine\n")
      runEnv(["--global-agents"], { HOME: home })
      const result = runEnv(["--remove-global-agents"], { HOME: home })
      expect(result.code).toBe(0)
      const content = readFileSync(file, "utf8")
      expect(content).toContain("# Mine")
      expect(content).not.toContain(BEGIN)
      expect(content).not.toContain("mcp__t3-code__")
    })

    test("--remove-global-agents is a no-op when the file or block is absent", () => {
      const home = scratch()
      const result = runEnv(["--remove-global-agents"], { HOME: home })
      expect(result.code).toBe(0)
      expect(result.out).toContain("no managed")
      mkdirSync(path.dirname(agentsFile(home)), { recursive: true })
      writeFileSync(agentsFile(home), "# user only\n")
      const again = runEnv(["--remove-global-agents"], { HOME: home })
      expect(again.code).toBe(0)
      expect(readFileSync(agentsFile(home), "utf8")).toBe("# user only\n")
    })

    test("fails clearly when HOME is unset", () => {
      const result = runEnv(["--global-agents"], { HOME: "" })
      expect(result.code).not.toBe(0)
      expect(result.err).toContain("HOME")
    })
  })
})
