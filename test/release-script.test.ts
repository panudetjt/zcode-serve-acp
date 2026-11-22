import { describe, expect, test } from "bun:test";
import {
  buildChangelogSection,
  buildReleaseBody,
  categorizeCommits,
  collectLogins,
  formatCredits,
  type ChangelogGroup,
  type CommitInfo,
  type ReleaseDeps,
  type ReleaseOptions,
  formatDate,
  main,
  nextVersion,
  parseArgs,
  parseCoAuthors,
  parseGitLog,
  parseRepoSlug,
  prependSection,
  runRelease,
  ReleaseError,
} from "../scripts/release.ts";

// --- fixtures ---------------------------------------------------------------

const US = "\u001f";
const RS = "\u001e";

function commitLine(fields: string[]): string {
  return `${fields.join(US)}${RS}`;
}

// Newest first, as `git log` emits. One commit per interesting shape:
// feature, breaking (subject "!"), breaking (footer), docs with co-author,
// bot commit, and a merge (two parents — must never surface).
const RAW_LOG = [
  commitLine([
    "f".repeat(40),
    "ffffff1",
    "Panu Det",
    "panu@a.example",
    "feat: channel auto-recovery",
    "",
    "body with detail",
  ]),
  commitLine([
    "b".repeat(40),
    "bbbbbbb",
    "Panu Det",
    "panu@b.example",
    "fix!: drop stale channel",
    "",
    "BREAKING CHANGE: config key renamed",
  ]),
  commitLine([
    "c".repeat(40),
    "ccccccc",
    "Panu Det",
    "panu@a.example",
    "docs: update readme",
    "",
    "Co-authored-by: Ada Lovelace <ada@c.example>\nextra line",
  ]),
  commitLine(["d".repeat(40), "ddddddd", "Dep Bot", "bot@noreply.example", "chore: bump deps", "", ""]),
  commitLine([
    "e".repeat(40),
    "eeeeeee",
    "Panu Det",
    "panu@a.example",
    "Merge pull request #7 from panudetjt/branch",
    "aaaaaaa bbbbbbb",
    "merge body",
  ]),
].join("");

const GH_LOGINS: Record<string, string> = {
  "panu@a.example": "panudetjt",
  "panu@b.example": "panudetjt",
  "ada@c.example": "ada",
  "bot@noreply.example": "dependabot[bot]",
};

// --- fake deps --------------------------------------------------------------

interface FakeOptions {
  gitLog?: string;
  tags?: string | null;
  existingTag?: string;
  branch?: string;
  status?: string;
  headSha?: string;
  originSha?: string;
  packageVersion?: string;
  changelogExists?: boolean;
  miseCode?: number;
  ghLogins?: Record<string, string>;
}

function makeDeps(options: FakeOptions = {}) {
  const gitCalls: string[][] = [];
  const ghCalls: string[][] = [];
  const miseCalls: string[][] = [];
  const bunCalls: string[][] = [];
  const writes: { path: string; content: string }[] = [];
  const chmods: { path: string; mode: number }[] = [];
  const logs: string[] = [];
  const errors: string[] = [];
  const written = new Set<string>();
  // Unified cross-surface timeline ("git commit", "gh release", "write:/path",
  // "chmod:/path") so ordering can be asserted across different dep methods.
  const events: string[] = [];
  let version = options.packageVersion ?? "0.3.0";

  const deps: ReleaseDeps = {
    cwd: "/repo",
    run(cmd, args) {
      events.push(`${cmd} ${args.join(" ")}`);
      if (cmd === "git") {
        gitCalls.push(args);
        const sub = args[0] ?? "";
        if (sub === "status") return { code: 0, out: options.status ?? "", err: "" };
        if (sub === "branch") return { code: 0, out: `${options.branch ?? "main"}\n`, err: "" };
        if (sub === "fetch") return { code: 0, out: "", err: "" };
        if (sub === "rev-parse") {
          const ref =
            args.slice(1).find((a) => a === "HEAD" || a === "origin/main" || a.startsWith("refs/tags/")) ?? "";
          if (ref.startsWith("refs/tags/")) {
            return ref === `refs/tags/${options.existingTag ?? "-none-"}`
              ? { code: 0, out: ref, err: "" }
              : { code: 1, out: "", err: "" };
          }
          if (ref === "HEAD") return { code: 0, out: `${options.headSha ?? "headsha"}\n`, err: "" };
          if (ref === "origin/main")
            return { code: 0, out: `${options.originSha ?? options.headSha ?? "headsha"}\n`, err: "" };
          return { code: 1, out: "", err: "" };
        }
        if (sub === "describe") {
          return options.tags === undefined || options.tags === null
            ? { code: 1, out: "", err: "" }
            : { code: 0, out: `${options.tags}\n`, err: "" };
        }
        if (sub === "rev-list") return { code: 0, out: `${"0".repeat(40)}\n`, err: "" };
        if (sub === "log") return { code: 0, out: options.gitLog ?? RAW_LOG, err: "" };
        if (sub === "remote") return { code: 0, out: "https://github.com/panudetjt/zcode-serve-acp.git\n", err: "" };
        if (sub === "add" || sub === "commit" || sub === "tag" || sub === "push") return { code: 0, out: "", err: "" };
        return { code: 1, out: "", err: `unexpected git subcommand: ${sub}` };
      }
      if (cmd === "gh") {
        ghCalls.push(args);
        if (args[0] === "api") {
          const decoded = decodeURIComponent(args[1] ?? "");
          const email = decoded.slice("search/users?q=".length, decoded.indexOf(" in:email"));
          const login = options.ghLogins?.[email];
          return login === undefined ? { code: 0, out: "", err: "" } : { code: 0, out: `${login}\n`, err: "" };
        }
        if (args[0] === "release") {
          return { code: 0, out: "https://github.com/panudetjt/zcode-serve-acp/releases/tag/v0.4.0\n", err: "" };
        }
        return { code: 1, out: "", err: `unexpected gh subcommand: ${args[0]}` };
      }
      if (cmd === "mise") {
        miseCalls.push(args);
        return { code: options.miseCode ?? 0, out: "", err: "" };
      }
      if (cmd === "bun") {
        bunCalls.push(args);
        return { code: 0, out: "", err: "" };
      }
      return { code: 1, out: "", err: `unexpected command: ${cmd}` };
    },
    readTextFile(filePath) {
      if (filePath.endsWith("package.json")) return JSON.stringify({ name: "zcode-serve-acp", version });
      throw new Error(`unexpected read: ${filePath}`);
    },
    writeTextFile(filePath, content) {
      writes.push({ path: filePath, content });
      written.add(filePath);
      events.push(`write:${filePath}`);
      if (filePath.endsWith("package.json")) {
        version = (JSON.parse(content) as { version: string }).version;
      }
    },
    fileExists(filePath) {
      if (written.has(filePath)) return true;
      if (filePath.endsWith("CHANGELOG.md")) return options.changelogExists ?? false;
      if (filePath.endsWith("bun.lock")) return true;
      return filePath.endsWith("package.json");
    },
    chmod(filePath, mode) {
      chmods.push({ path: filePath, mode });
      events.push(`chmod:${filePath}`);
    },
    now() {
      return new Date(2026, 10, 21, 9, 30, 0);
    },
    tmpDir() {
      return "/tmp-fake";
    },
    log(message) {
      logs.push(message);
    },
    logError(message) {
      errors.push(message);
    },
  };
  return {
    deps,
    gitCalls,
    ghCalls,
    miseCalls,
    bunCalls,
    writes,
    chmods,
    logs,
    errors,
    events,
    currentVersion: () => version,
  };
}

const gitSubs = (fake: ReturnType<typeof makeDeps>, sub: string): string[][] =>
  fake.gitCalls.filter((args) => args[0] === sub);

const MINOR: ReleaseOptions = { bump: "minor", dryRun: false, targets: ["bun-linux-x64"] };
const LOGINS = (email: string): string | null => GH_LOGINS[email] ?? null;

// --- arg parsing ------------------------------------------------------------

describe("parseArgs", () => {
  test("keyword bump with flags", () => {
    expect(parseArgs(["patch", "--dry-run"])).toEqual({
      bump: "patch",
      dryRun: true,
      targets: ["bun-linux-x64"],
    });
  });

  test("explicit semver and multiple targets", () => {
    expect(parseArgs(["1.2.3", "--targets=bun-linux-arm64,bun-darwin-x64"])).toEqual({
      bump: "1.2.3",
      dryRun: false,
      targets: ["bun-linux-arm64", "bun-darwin-x64"],
    });
  });

  test("missing version fails", () => {
    expect(() => parseArgs(["--dry-run"])).toThrow(ReleaseError);
  });

  test("invalid version fails", () => {
    expect(() => parseArgs(["bogus"])).toThrow('invalid version "bogus"');
  });

  test("unknown option fails", () => {
    expect(() => parseArgs(["patch", "--wat"])).toThrow('unknown option "--wat"');
  });

  test("second positional fails", () => {
    expect(() => parseArgs(["patch", "extra"])).toThrow('unexpected argument "extra"');
  });

  test("unknown target fails", () => {
    expect(() => parseArgs(["patch", "--targets=bun-linux-foo"])).toThrow('unknown target "bun-linux-foo"');
  });

  test("empty targets list fails", () => {
    expect(() => parseArgs(["patch", "--targets="])).toThrow("--targets must list at least one target");
  });
});

// --- version math -----------------------------------------------------------

describe("nextVersion", () => {
  test("patch / minor / major keywords", () => {
    expect(nextVersion("0.3.0", "patch")).toBe("0.3.1");
    expect(nextVersion("0.3.0", "minor")).toBe("0.4.0");
    expect(nextVersion("0.3.0", "major")).toBe("1.0.0");
  });

  test("explicit semver passes through", () => {
    expect(nextVersion("0.3.0", "1.2.3")).toBe("1.2.3");
  });

  test("explicit equal to current fails", () => {
    expect(() => nextVersion("0.3.0", "0.3.0")).toThrow("already current");
  });

  test("invalid current version fails", () => {
    expect(() => nextVersion("x.y", "patch")).toThrow("not valid semver");
  });
});

describe("formatDate", () => {
  test("zero-pads month and day", () => {
    expect(formatDate(new Date(2026, 0, 3))).toBe("2026-01-03");
    expect(formatDate(new Date(2026, 10, 21))).toBe("2026-11-21");
  });
});

// --- git log parsing ---------------------------------------------------------

describe("parseGitLog", () => {
  test("parses every field of the record format", () => {
    const commits = parseGitLog(RAW_LOG);
    expect(commits).toHaveLength(5);
    const first = commits[0]!;
    expect(first.hash).toBe("f".repeat(40));
    expect(first.short).toBe("ffffff1");
    expect(first.authorEmail).toBe("panu@a.example");
    expect(first.subject).toBe("feat: channel auto-recovery");
    expect(first.parents).toEqual([]);
  });

  test("captures merge parents and co-author bodies", () => {
    const commits = parseGitLog(RAW_LOG);
    expect(commits[4]!.parents).toEqual(["aaaaaaa", "bbbbbbb"]);
    expect(commits[2]!.body).toContain("Co-authored-by: Ada Lovelace <ada@c.example>");
  });

  test("empty and malformed records are dropped", () => {
    expect(parseGitLog("")).toEqual([]);
    expect(parseGitLog(`${RS}${commitLine(["a", "a", "n", "e", "s", "", ""])}junk`)).toHaveLength(1);
  });
});

describe("parseCoAuthors", () => {
  test("finds every trailer", () => {
    const people = parseCoAuthors("x\nCo-authored-by: Ada <ada@c.example>\nCo-authored-by: Bob <bob@d.example>\n");
    expect(people).toEqual([
      { name: "Ada", email: "ada@c.example" },
      { name: "Bob", email: "bob@d.example" },
    ]);
  });

  test("no trailers yields none", () => {
    expect(parseCoAuthors("plain body")).toEqual([]);
  });
});

// --- changelog building -------------------------------------------------------

describe("categorizeCommits", () => {
  test("orders sections and skips merges", () => {
    const groups = categorizeCommits(parseGitLog(RAW_LOG));
    expect(groups.map((g: ChangelogGroup) => g.section)).toEqual([
      "Breaking Changes",
      "Features",
      "Documentation",
      "Chores",
    ]);
    expect(groups[0]!.commits[0]!.subject).toBe("fix!: drop stale channel");
    expect(groups[3]!.commits[0]!.subject).toBe("chore: bump deps");
  });

  test("footer BREAKING CHANGE marks breaking too", () => {
    const groups = categorizeCommits(parseGitLog(RAW_LOG));
    expect(groups[0]!.commits.map((c: CommitInfo) => c.subject)).toEqual(["fix!: drop stale channel"]);
  });

  test("untyped subjects land in Chores", () => {
    const groups = categorizeCommits([
      {
        hash: "a",
        short: "a1",
        authorName: "N",
        authorEmail: "e@x",
        subject: "random work without a type",
        parents: [],
        body: "",
      },
    ]);
    expect(groups.map((g) => g.section)).toEqual(["Chores"]);
  });
});

describe("formatCredits", () => {
  test("dedupes identities sharing one login", () => {
    const credits = formatCredits({ name: "Panu", email: "panu@a.example" }, [], (email) =>
      email === "panu@a.example" || email === "panu@b.example" ? "panudetjt" : null,
    );
    expect(credits).toBe("@panudetjt");
  });

  test("includes co-authors after the author", () => {
    const credits = formatCredits(
      { name: "Panu", email: "panu@a.example" },
      [{ name: "Ada", email: "ada@c.example" }],
      LOGINS,
    );
    expect(credits).toBe("@panudetjt, @ada");
  });

  test("drops bots and falls back to names", () => {
    const credits = formatCredits(
      { name: "Dep Bot", email: "bot@noreply.example" },
      [{ name: "Unmapped", email: "who@nowhere.example" }],
      LOGINS,
    );
    expect(credits).toBe("Unmapped");
  });
});

describe("collectLogins", () => {
  test("unique mapped logins, bots excluded, merges skipped", () => {
    const logins = collectLogins(parseGitLog(RAW_LOG), LOGINS);
    expect(logins).toEqual(["@panudetjt", "@ada"]);
  });
});

describe("buildChangelogSection", () => {
  test("renders the section with credited entries", () => {
    const section = buildChangelogSection("0.4.0", "2026-11-21", parseGitLog(RAW_LOG), LOGINS);
    expect(section).toBe(
      [
        "## v0.4.0 — 2026-11-21",
        "",
        "### Breaking Changes",
        "- fix!: drop stale channel (bbbbbbb) — @panudetjt",
        "",
        "### Features",
        "- feat: channel auto-recovery (ffffff1) — @panudetjt",
        "",
        "### Documentation",
        "- docs: update readme (ccccccc) — @panudetjt, @ada",
        "",
        "### Chores",
        "- chore: bump deps (ddddddd)",
      ].join("\n"),
    );
  });
});

describe("prependSection", () => {
  test("bootstraps the file on first release", () => {
    expect(prependSection(null, "## v0.4.0 — 2026-11-21")).toBe("# Changelog\n\n## v0.4.0 — 2026-11-21\n");
    expect(prependSection("", "## v0.4.0 — 2026-11-21")).toBe("# Changelog\n\n## v0.4.0 — 2026-11-21\n");
  });

  test("inserts above the oldest section", () => {
    const existing = "# Changelog\n\n## v0.3.0 — 2026-01-01\n\n### Features\n- old (aaaaaaa)\n";
    const result = prependSection(existing, "## v0.4.0 — 2026-11-21");
    expect(result).toBe(
      "# Changelog\n\n## v0.4.0 — 2026-11-21\n\n## v0.3.0 — 2026-01-01\n\n### Features\n- old (aaaaaaa)\n",
    );
  });

  test("appends when the file has no sections yet", () => {
    const result = prependSection("# Changelog\n\nnotes\n", "## v0.4.0 — 2026-11-21");
    expect(result).toBe("# Changelog\n\nnotes\n\n## v0.4.0 — 2026-11-21\n");
  });
});

describe("buildReleaseBody", () => {
  test("section + contributors + compare link", () => {
    const body = buildReleaseBody(
      "## v0.4.0 — 2026-11-21",
      ["@panudetjt"],
      "https://github.com/o/r/compare/a...v0.4.0",
    );
    expect(body).toBe(
      "## v0.4.0 — 2026-11-21\n\n**Contributors**: @panudetjt\n\n**Full Changelog**: https://github.com/o/r/compare/a...v0.4.0\n",
    );
  });

  test("omits the contributors line when nothing mapped", () => {
    const body = buildReleaseBody("## v0.4.0 — 2026-11-21", [], "https://github.com/o/r/compare/a...v0.4.0");
    expect(body).not.toContain("Contributors");
    expect(body).toContain("Full Changelog");
  });
});

describe("parseRepoSlug", () => {
  test("parses https and ssh URLs", () => {
    expect(parseRepoSlug("https://github.com/panudetjt/zcode-serve-acp.git")).toBe("panudetjt/zcode-serve-acp");
    expect(parseRepoSlug("https://github.com/panudetjt/zcode-serve-acp")).toBe("panudetjt/zcode-serve-acp");
    expect(parseRepoSlug("git@github.com:panudetjt/zcode-serve-acp.git")).toBe("panudetjt/zcode-serve-acp");
  });

  test("unknown URL shapes fail with null", () => {
    expect(parseRepoSlug("file:///tmp/x")).toBeNull();
    expect(parseRepoSlug("")).toBeNull();
  });
});

// --- the release flow ---------------------------------------------------------

describe("runRelease (full path)", () => {
  test("gates, writes, commit, tag, push, compile, draft release — in order", () => {
    const fake = makeDeps({ ghLogins: GH_LOGINS });
    const exit = runRelease(MINOR, fake.deps);

    expect(exit).toBe(0);
    expect(fake.currentVersion()).toBe("0.4.0");

    expect(fake.miseCalls.map((args) => args[1])).toEqual(["check", "test", "fmt-check", "lint"]);

    const changelog = fake.writes.find((w) => w.path === "/repo/CHANGELOG.md");
    expect(changelog?.content.startsWith("# Changelog\n\n## v0.4.0 — 2026-11-21\n\n### Breaking Changes\n")).toBe(true);
    expect(changelog?.content).toContain("- feat: channel auto-recovery (ffffff1) — @panudetjt");

    expect(gitSubs(fake, "add")[0]).toEqual(["add", "/repo/CHANGELOG.md", "/repo/package.json", "/repo/bun.lock"]);
    expect(gitSubs(fake, "commit")[0]).toEqual(["commit", "-m", "chore: bump version to 0.4.0"]);
    expect(gitSubs(fake, "tag")[0]).toEqual(["tag", "-a", "v0.4.0", "-m", "v0.4.0"]);
    expect(gitSubs(fake, "push")[0]).toEqual(["push", "origin", "main", "v0.4.0"]);
    expect(fake.bunCalls).toContainEqual(["install"]);

    expect(fake.bunCalls).toContainEqual([
      "build",
      "--compile",
      "--target=bun-linux-x64",
      "--outfile=/repo/dist/zcode-serve-acp-linux-x64",
      "src/bin.ts",
    ]);
    expect(fake.chmods).toEqual([{ path: "/repo/dist/zcode-serve-acp-linux-x64", mode: 0o755 }]);

    const notes = fake.writes.find((w) => w.path === "/tmp-fake/release-body-v0.4.0.md");
    expect(notes?.content).toContain("**Contributors**: @panudetjt, @ada");
    expect(notes?.content).toContain("**Full Changelog**: https://github.com/panudetjt/zcode-serve-acp/compare/");
    const releaseCall = fake.ghCalls.find((args) => args[0] === "release") ?? [];
    expect(releaseCall.slice(0, 6)).toEqual(["release", "create", "v0.4.0", "--draft", "--title", "v0.4.0"]);
    expect(releaseCall.slice(6)).toEqual(["--notes-file", "/tmp-fake/release-body-v0.4.0.md"]);
    expect(fake.logs.join("\n")).toContain("draft release created");

    const at = (prefix: string) => fake.events.findIndex((e) => e.startsWith(prefix));
    const gatesAt = at("mise run check");
    const changelogAt = at("write:/repo/CHANGELOG.md");
    const commitAt = at("git commit");
    const tagAt = at("git tag");
    const pushAt = at("git push");
    const releaseAt = at("gh release");
    expect(gatesAt).toBeGreaterThanOrEqual(0);
    expect(gatesAt).toBeLessThan(changelogAt);
    expect(changelogAt).toBeLessThan(commitAt);
    expect(commitAt).toBeLessThan(tagAt);
    expect(tagAt).toBeLessThan(pushAt);
    expect(pushAt).toBeLessThan(releaseAt);
  });

  test("honors an existing tag as the changelog base", () => {
    const fake = makeDeps({ tags: "v0.3.0", ghLogins: GH_LOGINS });
    expect(runRelease(MINOR, fake.deps)).toBe(0);
    const logCall = gitSubs(fake, "log")[0] ?? [];
    expect(logCall[1]).toBe("v0.3.0..HEAD");
    const notes = fake.writes.find((w) => w.path === "/tmp-fake/release-body-v0.4.0.md");
    expect(notes?.content).toContain(
      "**Full Changelog**: https://github.com/panudetjt/zcode-serve-acp/compare/v0.3.0...v0.4.0",
    );
  });

  test("explicit target compiles that target's asset name", () => {
    const fake = makeDeps();
    expect(runRelease({ ...MINOR, targets: ["bun-darwin-arm64"] }, fake.deps)).toBe(0);
    expect(fake.bunCalls).toContainEqual([
      "build",
      "--compile",
      "--target=bun-darwin-arm64",
      "--outfile=/repo/dist/zcode-serve-acp-darwin-arm64",
      "src/bin.ts",
    ]);
  });

  test("dirty tree refuses before any mutation", () => {
    const fake = makeDeps({ status: " M src/x.ts\n" });
    expect(() => runRelease(MINOR, fake.deps)).toThrow("working tree is not clean");
    expect(fake.writes).toHaveLength(0);
    expect(gitSubs(fake, "commit")).toHaveLength(0);
  });

  test("non-main branch refuses", () => {
    const fake = makeDeps({ branch: "feature" });
    expect(() => runRelease(MINOR, fake.deps)).toThrow('releases run from main only (you are on "feature")');
  });

  test("stale main refuses", () => {
    const fake = makeDeps({ headSha: "newsha", originSha: "oldsha" });
    expect(() => runRelease(MINOR, fake.deps)).toThrow("not up to date with origin/main");
  });

  test("existing tag refuses", () => {
    const fake = makeDeps({ existingTag: "v0.4.0" });
    expect(() => runRelease(MINOR, fake.deps)).toThrow("tag v0.4.0 already exists");
  });

  test("gate failure aborts with the task name", () => {
    const fake = makeDeps({ miseCode: 1 });
    expect(() => runRelease(MINOR, fake.deps)).toThrow("mise run check failed");
    expect(fake.writes).toHaveLength(0);
  });

  test("no commits since the last tag refuses", () => {
    const fake = makeDeps({ tags: "v0.3.0", gitLog: "" });
    expect(() => runRelease(MINOR, fake.deps)).toThrow("no commits since v0.3.0");
  });
});

describe("runRelease (--dry-run)", () => {
  test("prints the plan and previews without a single mutation", () => {
    const fake = makeDeps({ branch: "feature", ghLogins: GH_LOGINS });
    const exit = runRelease({ ...MINOR, dryRun: true }, fake.deps);

    expect(exit).toBe(0);
    expect(fake.writes).toHaveLength(0);
    expect(fake.chmods).toHaveLength(0);
    expect(fake.ghCalls).toHaveLength(0);
    expect(fake.miseCalls).toHaveLength(0);
    expect(fake.bunCalls).toHaveLength(0);
    for (const sub of ["add", "commit", "tag", "push", "fetch"]) {
      expect(gitSubs(fake, sub)).toHaveLength(0);
    }

    const transcript = fake.logs.join("\n");
    expect(transcript).toContain("[dry-run]");
    expect(transcript).toContain("version: 0.3.0 → 0.4.0 (tag v0.4.0)");
    expect(transcript).toContain("mise run check, test, fmt-check, lint (skipped)");
    expect(transcript).toContain("dist/zcode-serve-acp-linux-x64");
    expect(transcript).toContain("### Features");
    expect(transcript).toContain("**Full Changelog**: https://github.com/panudetjt/zcode-serve-acp/compare/");
  });

  test("dry-run without gh falls back to names", () => {
    const fake = makeDeps();
    expect(runRelease({ ...MINOR, dryRun: true }, fake.deps)).toBe(0);
    expect(fake.logs.join("\n")).toContain("- feat: channel auto-recovery (ffffff1) — Panu Det");
  });
});

describe("main", () => {
  test("valid argv runs to completion", () => {
    const fake = makeDeps({ ghLogins: GH_LOGINS });
    expect(main(["minor", "--dry-run"], fake.deps)).toBe(0);
  });

  test("invalid argv reports on stderr and exits 1", () => {
    const fake = makeDeps();
    expect(main(["bogus"], fake.deps)).toBe(1);
    expect(fake.errors).toHaveLength(1);
    expect(fake.errors[0]).toContain('invalid version "bogus"');
  });
});
