#!/usr/bin/env bun
/**
 * Release script — the maintainer's manual release lever (no automation).
 *
 * Usage: mise run release -- patch|minor|major|X.Y.Z [--dry-run] [--targets=bun-linux-x64,...]
 *
 * Run from `main` on a clean, up-to-date tree. It:
 *   1. runs the CI gates (check / test / fmt-check / lint) via mise,
 *   2. builds the new CHANGELOG.md section from `git log` since the last tag
 *      (first release: since the first commit), skipping merge commits,
 *      categorizing conventional-commit types, crediting the author and any
 *      `Co-authored-by:` trailers with their GitHub login (via `gh api`,
 *      cached per run; bots dropped; unmapped people fall back to their name),
 *   3. prepends the section to CHANGELOG.md (bootstraps the file on first
 *      release), bumps package.json, syncs bun.lock, and commits
 *      `chore: bump version to X.Y.Z`,
 *   4. tags `vX.Y.Z` (annotated), pushes main + the tag,
 *   5. compiles the Bridge binary per target into
 *      `dist/zcode-serve-acp-<os>-<arch>` (default target: bun-linux-x64),
 *   6. creates a DRAFT GitHub release with the section plus a Contributors
 *      summary and a compare link — the maintainer reviews and publishes.
 *
 * `--dry-run` prints the plan and the full release body without touching
 * anything (no gates, no gh, no commit/tag/push/install) — usable from any
 * branch; contributor mapping falls back to names because it would need gh.
 *
 * This is a plain tooling script (capture-frames.ts precedent): node builtins
 * directly, no Effect, all logic in exported functions with injected deps so
 * test/release-script.test.ts covers it without real git/gh. The one JSON
 * boundary it owns (package.json version) is validated inline.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/** Result of one external process invocation (git / gh / mise / bun). */
export interface RunResult {
  code: number;
  out: string;
  err: string;
}

/** Side surface of the release flow — injected so tests run without real git/gh. */
export interface ReleaseDeps {
  cwd: string;
  run(cmd: string, args: string[]): RunResult;
  readTextFile(filePath: string): string;
  writeTextFile(filePath: string, content: string): void;
  fileExists(filePath: string): boolean;
  chmod(filePath: string, mode: number): void;
  now(): Date;
  tmpDir(): string;
  log(message: string): void;
  logError(message: string): void;
}

export interface ReleaseOptions {
  bump: string;
  dryRun: boolean;
  targets: string[];
}

export interface CommitInfo {
  hash: string;
  short: string;
  authorName: string;
  authorEmail: string;
  subject: string;
  parents: string[];
  body: string;
}

export interface Person {
  name: string;
  email: string;
}

/** email → GitHub login (null = unmapped, fall back to the person's name). */
export type LoginLookup = (email: string) => string | null;

export interface ChangelogGroup {
  section: string;
  commits: CommitInfo[];
}

export class ReleaseError extends Error {}

const BUMP_KEYWORDS = new Set(["patch", "minor", "major"]);
const BUN_TARGETS: readonly string[] = [
  "bun-linux-x64",
  "bun-linux-arm64",
  "bun-darwin-x64",
  "bun-darwin-arm64",
  "bun-windows-x64",
];
const GATES: readonly string[] = ["check", "test", "fmt-check", "lint"];
const SECTION_ORDER: readonly string[] = [
  "Breaking Changes",
  "Features",
  "Bug Fixes",
  "Documentation",
  "Refactoring",
  "Performance",
  "Tests",
  "Chores",
];
const TYPE_TO_SECTION: Record<string, string> = {
  feat: "Features",
  fix: "Bug Fixes",
  docs: "Documentation",
  refactor: "Refactoring",
  perf: "Performance",
  test: "Tests",
};

// git record format for `git log --format=...` — unit separator (\x1f) between
// fields, record separator (\x1e) between commits, so subjects/bodies with any
// ordinary whitespace still parse.
const GIT_LOG_FORMAT = "%H%x1f%h%x1f%an%x1f%ae%x1f%s%x1f%P%x1f%b%x1e";

function fail(message: string): never {
  throw new ReleaseError(message);
}

function ensure(condition: boolean, message: string): asserts condition {
  if (!condition) fail(message);
}

export function parseArgs(argv: string[]): ReleaseOptions {
  let bump: string | undefined;
  let dryRun = false;
  let targets: string[] | undefined;
  for (const arg of argv) {
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (arg.startsWith("--targets=")) {
      const list = arg
        .slice("--targets=".length)
        .split(",")
        .map((t) => t.trim())
        .filter((t) => t !== "");
      ensure(list.length > 0, "--targets must list at least one target");
      for (const t of list) {
        ensure(BUN_TARGETS.includes(t), `unknown target "${t}" — supported: ${BUN_TARGETS.join(", ")}`);
      }
      targets = list;
      continue;
    }
    if (arg.startsWith("--")) fail(`unknown option "${arg}"`);
    if (bump !== undefined) fail(`unexpected argument "${arg}"`);
    bump = arg;
  }
  if (bump === undefined) {
    fail("usage: mise run release -- patch|minor|major|X.Y.Z [--dry-run] [--targets=bun-linux-x64,...]");
  }
  ensure(
    BUMP_KEYWORDS.has(bump) || /^\d+\.\d+\.\d+$/.test(bump),
    `invalid version "${bump}" — use patch|minor|major or X.Y.Z`,
  );
  return { bump, dryRun, targets: targets ?? ["bun-linux-x64"] };
}

export function nextVersion(current: string, bump: string): string {
  const parts = current.split(".");
  ensure(parts.length === 3 && parts.every((p) => /^\d+$/.test(p)), `current version "${current}" is not valid semver`);
  if (/^\d+\.\d+\.\d+$/.test(bump)) {
    ensure(bump !== current, `version ${current} is already current — nothing to release`);
    return bump;
  }
  const major = Number(parts[0]);
  const minor = Number(parts[1]);
  const patch = Number(parts[2]);
  if (bump === "patch") return `${major}.${minor}.${patch + 1}`;
  if (bump === "minor") return `${major}.${minor + 1}.0`;
  return `${major + 1}.0.0`;
}

export function formatDate(date: Date): string {
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

export function parseGitLog(raw: string): CommitInfo[] {
  const commits: CommitInfo[] = [];
  for (const record of raw.split("\u001e")) {
    if (record.trim() === "") continue;
    const fields = record.split("\u001f");
    if (fields.length < 7) continue;
    commits.push({
      hash: fields[0] ?? "",
      short: fields[1] ?? "",
      authorName: fields[2] ?? "",
      authorEmail: fields[3] ?? "",
      subject: fields[4] ?? "",
      parents: (fields[5] ?? "")
        .trim()
        .split(" ")
        .filter((p) => p !== ""),
      body: fields[6] ?? "",
    });
  }
  return commits;
}

export function parseCoAuthors(body: string): Person[] {
  const people: Person[] = [];
  for (const match of body.matchAll(/^Co-authored-by:\s*(.*?)\s*<(.*?)>\s*$/gim)) {
    people.push({ name: match[1] ?? "", email: match[2] ?? "" });
  }
  return people;
}

const BREAKING_SUBJECT = /^\w+(\([^)]*\))?!:/;
const CONVENTIONAL_TYPE = /^(\w+)(\([^)]*\))?:/;

export function isBreakingCommit(commit: CommitInfo): boolean {
  return BREAKING_SUBJECT.test(commit.subject) || /^BREAKING CHANGE:/m.test(commit.body);
}

export function categorizeCommits(commits: CommitInfo[]): ChangelogGroup[] {
  const bySection = new Map<string, CommitInfo[]>();
  for (const commit of commits) {
    if (commit.parents.length > 1) continue; // merge commits never get an entry
    let section = "Chores";
    if (isBreakingCommit(commit)) {
      section = "Breaking Changes";
    } else {
      const type = CONVENTIONAL_TYPE.exec(commit.subject)?.[1];
      section = (type !== undefined && TYPE_TO_SECTION[type]) || "Chores";
    }
    const bucket = bySection.get(section);
    if (bucket === undefined) bySection.set(section, [commit]);
    else bucket.push(commit);
  }
  return SECTION_ORDER.filter((s) => bySection.has(s)).map((s) => ({
    section: s,
    commits: bySection.get(s) ?? [],
  }));
}

function isBot(person: Person, login: string | null): boolean {
  return person.name.endsWith("[bot]") || (login !== null && login.endsWith("[bot]"));
}

export function formatCredits(author: Person, coAuthors: Person[], lookup: LoginLookup): string {
  const seenEmails = new Set<string>();
  const seenDisplays = new Set<string>();
  const parts: string[] = [];
  for (const person of [author, ...coAuthors]) {
    const emailKey = person.email.toLowerCase();
    if (seenEmails.has(emailKey)) continue;
    seenEmails.add(emailKey);
    const login = lookup(person.email);
    if (isBot(person, login)) continue;
    const display = login === null ? person.name : `@${login}`;
    if (seenDisplays.has(display)) continue; // two emails, one GitHub login
    seenDisplays.add(display);
    parts.push(display);
  }
  return parts.join(", ");
}

export function collectLogins(commits: CommitInfo[], lookup: LoginLookup): string[] {
  const logins = new Set<string>();
  for (const commit of commits) {
    for (const person of [{ name: commit.authorName, email: commit.authorEmail }, ...parseCoAuthors(commit.body)]) {
      const login = lookup(person.email);
      if (login === null || isBot(person, login)) continue;
      logins.add(`@${login}`);
    }
  }
  return [...logins];
}

export function buildChangelogSection(
  version: string,
  date: string,
  commits: CommitInfo[],
  lookup: LoginLookup,
): string {
  const lines: string[] = [`## v${version} — ${date}`];
  for (const group of categorizeCommits(commits)) {
    lines.push("", `### ${group.section}`);
    for (const commit of group.commits) {
      const credits = formatCredits(
        { name: commit.authorName, email: commit.authorEmail },
        parseCoAuthors(commit.body),
        lookup,
      );
      lines.push(
        credits === "" ? `- ${commit.subject} (${commit.short})` : `- ${commit.subject} (${commit.short}) — ${credits}`,
      );
    }
  }
  return lines.join("\n");
}

export function prependSection(existing: string | null, section: string): string {
  if (existing === null || existing.trim() === "") return `# Changelog\n\n${section}\n`;
  const firstSection = existing.indexOf("\n## ");
  if (firstSection === -1) return `${existing.trimEnd()}\n\n${section}\n`;
  const head = existing.slice(0, firstSection).trimEnd();
  const rest = existing.slice(firstSection + 1).trimEnd();
  return `${head}\n\n${section}\n\n${rest}\n`;
}

export function buildReleaseBody(section: string, logins: string[], compareUrl: string): string {
  const parts: string[] = [section];
  if (logins.length > 0) parts.push("", `**Contributors**: ${logins.join(", ")}`);
  parts.push("", `**Full Changelog**: ${compareUrl}`);
  return `${parts.join("\n")}\n`;
}

export function parseRepoSlug(remoteUrl: string): string | null {
  const ssh = /^git@[^:]+:([^/]+)\/(.+?)\.git$/.exec(remoteUrl);
  if (ssh !== null) return `${ssh[1]}/${ssh[2]}`;
  const https = /^https?:\/\/[^/]+\/([^/]+)\/(.+?)(\.git)?$/.exec(remoteUrl);
  if (https !== null) return `${https[1]}/${https[2]}`;
  return null;
}

function readPackage(deps: ReleaseDeps): { raw: Record<string, unknown>; version: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(deps.readTextFile(path.join(deps.cwd, "package.json")));
  } catch {
    fail("cannot read package.json");
  }
  if (typeof parsed === "object" && parsed !== null && "version" in parsed) {
    const version = (parsed as Record<string, unknown>)["version"];
    if (typeof version === "string") return { raw: parsed as Record<string, unknown>, version };
  }
  fail("package.json has no version string");
}

function resolveOldTag(deps: ReleaseDeps): string | null {
  const res = deps.run("git", ["describe", "--tags", "--abbrev=0"]);
  return res.code === 0 && res.out.trim() !== "" ? res.out.trim() : null;
}

function firstCommit(deps: ReleaseDeps): string {
  const res = deps.run("git", ["rev-list", "--max-parents=0", "HEAD"]);
  ensure(res.code === 0 && res.out.trim() !== "", "cannot determine the first commit of this repository");
  const roots = res.out.trim().split("\n");
  return roots[0] ?? "";
}

function originSlug(deps: ReleaseDeps): string {
  const res = deps.run("git", ["remote", "get-url", "origin"]);
  ensure(res.code === 0, "cannot read the origin remote URL");
  const slug = parseRepoSlug(res.out.trim());
  ensure(slug !== null, `cannot parse owner/repo from origin URL "${res.out.trim()}"`);
  return slug;
}

function ghLookupLogin(deps: ReleaseDeps, email: string): string | null {
  const res = deps.run("gh", [
    "api",
    `search/users?q=${encodeURIComponent(`${email} in:email`)}`,
    "--jq",
    ".items[0].login",
  ]);
  if (res.code !== 0) return null;
  const login = res.out.trim();
  return login === "" ? null : login;
}

function assertRepoState(deps: ReleaseDeps): void {
  const status = deps.run("git", ["status", "--porcelain"]);
  ensure(status.code === 0 && status.out.trim() === "", "working tree is not clean — commit or stash first");
  const branch = deps.run("git", ["branch", "--show-current"]);
  ensure(
    branch.code === 0 && branch.out.trim() === "main",
    `releases run from main only (you are on "${branch.out.trim()}")`,
  );
  ensure(deps.run("git", ["fetch", "origin", "main"]).code === 0, "git fetch origin main failed");
  const head = deps.run("git", ["rev-parse", "HEAD"]);
  const origin = deps.run("git", ["rev-parse", "origin/main"]);
  ensure(
    head.code === 0 && origin.code === 0 && head.out.trim() === origin.out.trim(),
    "main is not up to date with origin/main — pull first",
  );
}

function ensureTagFree(deps: ReleaseDeps, tag: string): void {
  const res = deps.run("git", ["rev-parse", "--verify", "--quiet", `refs/tags/${tag}`]);
  ensure(res.code !== 0, `tag ${tag} already exists`);
}

function runGates(deps: ReleaseDeps): void {
  for (const task of GATES) {
    const res = deps.run("mise", ["run", task]);
    ensure(res.code === 0, `mise run ${task} failed:\n${(res.err || res.out).trim()}`);
  }
}

function cachedLookup(deps: ReleaseDeps, dryRun: boolean): LoginLookup {
  const cache = new Map<string, string | null>();
  return (email) => {
    if (!cache.has(email)) cache.set(email, dryRun ? null : ghLookupLogin(deps, email));
    return cache.get(email) ?? null;
  };
}

/** One release, start to finish. Returns the exit code (0); failures throw. */
export function runRelease(options: ReleaseOptions, deps: ReleaseDeps): number {
  const pkg = readPackage(deps);
  const version = nextVersion(pkg.version, options.bump);
  const tag = `v${version}`;
  const dryRun = options.dryRun;

  const oldTag = resolveOldTag(deps);
  const baseRef = oldTag ?? firstCommit(deps);
  const log = deps.run("git", [
    "log",
    ...(oldTag === null ? ["HEAD"] : [`${oldTag}..HEAD`]),
    `--format=${GIT_LOG_FORMAT}`,
  ]);
  ensure(log.code === 0, `git log failed: ${log.err.trim()}`);
  const commits = parseGitLog(log.out);
  ensure(commits.length > 0, `no commits since ${oldTag ?? "the first commit"} — nothing to release`);

  const lookup = cachedLookup(deps, dryRun);
  const section = buildChangelogSection(version, formatDate(deps.now()), commits, lookup);
  const slug = originSlug(deps);
  const body = buildReleaseBody(
    section,
    collectLogins(commits, lookup),
    `https://github.com/${slug}/compare/${baseRef}...${tag}`,
  );

  if (dryRun) {
    deps.log("[dry-run] no changes will be made");
    deps.log(`version: ${pkg.version} → ${version} (tag ${tag})`);
    deps.log(`base: ${oldTag ?? "no tags — first release, from the first commit"}`);
    deps.log(`gates would run: mise run ${GATES.join(", ")} (skipped)`);
    deps.log(
      `assets would be compiled: ${options.targets.map((t) => `dist/zcode-serve-acp-${t.slice("bun-".length)}`).join(", ")}`,
    );
    deps.log("--- changelog section preview ---");
    deps.log(section);
    deps.log("--- release body preview ---");
    deps.log(body);
    deps.log("[dry-run] done");
    return 0;
  }

  assertRepoState(deps);
  ensureTagFree(deps, tag);
  runGates(deps);

  const changelogPath = path.join(deps.cwd, "CHANGELOG.md");
  const existing = deps.fileExists(changelogPath) ? deps.readTextFile(changelogPath) : null;
  deps.writeTextFile(changelogPath, prependSection(existing, section));
  deps.writeTextFile(pkgPath(deps), `${JSON.stringify({ ...pkg.raw, version }, null, 2)}\n`);
  deps.log(`changelog + package.json updated → ${version}`);
  ensure(deps.run("bun", ["install"]).code === 0, "bun install (bun.lock sync) failed");

  const lockPath = path.join(deps.cwd, "bun.lock");
  const files = [changelogPath, pkgPath(deps), lockPath].filter((p) => deps.fileExists(p));
  ensure(deps.run("git", ["add", ...files]).code === 0, "git add failed");
  const commit = deps.run("git", ["commit", "-m", `chore: bump version to ${version}`]);
  ensure(commit.code === 0, `git commit failed: ${commit.err.trim()}`);
  ensure(deps.run("git", ["tag", "-a", tag, "-m", tag]).code === 0, `git tag ${tag} failed`);
  const push = deps.run("git", ["push", "origin", "main", tag]);
  ensure(push.code === 0, `git push failed: ${push.err.trim()}`);
  deps.log(`pushed main + ${tag}`);

  for (const target of options.targets) {
    const asset = path.join(deps.cwd, "dist", `zcode-serve-acp-${target.slice("bun-".length)}`);
    const build = deps.run("bun", ["build", "--compile", `--target=${target}`, `--outfile=${asset}`, "src/bin.ts"]);
    ensure(build.code === 0, `compile ${target} failed:\n${(build.err || build.out).trim()}`);
    deps.chmod(asset, 0o755);
    deps.log(`asset ready → ${asset}`);
  }

  const notesPath = path.join(deps.tmpDir(), `release-body-${tag}.md`);
  deps.writeTextFile(notesPath, body);
  const create = deps.run("gh", ["release", "create", tag, "--draft", "--title", tag, "--notes-file", notesPath]);
  ensure(create.code === 0, `gh release create failed: ${create.err.trim()}`);
  deps.log(`draft release created: ${create.out.trim()}`);
  deps.log("review the draft on GitHub and publish when ready");
  return 0;
}

function pkgPath(deps: ReleaseDeps): string {
  return path.join(deps.cwd, "package.json");
}

export function main(argv: string[], deps: ReleaseDeps = realDeps()): number {
  try {
    return runRelease(parseArgs(argv), deps);
  } catch (error) {
    deps.logError(`release failed: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

function realDeps(): ReleaseDeps {
  const repoRoot = path.resolve(import.meta.dir, "..");
  return {
    cwd: repoRoot,
    run(cmd, args) {
      const proc = spawnSync(cmd, args, { cwd: repoRoot, encoding: "utf8" });
      return { code: proc.status ?? -1, out: proc.stdout ?? "", err: proc.stderr ?? "" };
    },
    readTextFile: (filePath) => readFileSync(filePath, "utf8"),
    writeTextFile: (filePath, content) => writeFileSync(filePath, content),
    fileExists: (filePath) => existsSync(filePath),
    chmod: (filePath, mode) => chmodSync(filePath, mode),
    now: () => new Date(),
    tmpDir: () => tmpdir(),
    log: (message) => console.log(message),
    logError: (message) => console.error(message),
  };
}

if (import.meta.main) process.exitCode = main(process.argv.slice(2));
