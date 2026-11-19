# Vendor the Effect repository via git subtree

Coding agents write substantially better Effect when they can read real source
instead of guessing from docs or web search — Effect's API surface shifted
enough between v3 and v4 that model memory is actively misleading (as of
2026-11: the npm 4.1.4 release lacks `Effect.catch`, `makeWebSocket` lives
differently than in the vendored main, etc.). We vendor the full
Effect-TS/effect monorepo at `repos/effect` via
`git subtree add --prefix=repos/effect --squash` and update it with
`git subtree pull --prefix=repos/effect --squash …` so each update is exactly
one reviewable commit.

Rules (see AGENTS.md): `repos/` is read-only reference — never edited, never
imported from; dependencies come from npm (`effect`, `@effect/platform-bun`).
Trade-off: the checkout grows (~80 MB) and we maintain the subtree ourselves;
the improvement in generated-code quality is worth it.

Note: the vendored `main` can run AHEAD of the npm release — when the two
disagree, the installed npm package is ground truth for what compiles.

## Update — 20 พ.ย. 2026: switched to a gitignored reference clone (`.repos/effect`)

The committed subtree (3,451 files, ~80 MB in tree and history) is replaced by a
gitignored local clone at `.repos/effect` — the form the org brain's
"vendored-reference hygiene" rule (second-brains, `ai-native-dev-workflow` 🔴⑤,
baked 19 พ.ย. 2026) prescribes for app repos, and the same form the
Effect-TS/tsgo repo itself uses for its reference clones. Reasons:

1. Nothing consumed the committed copy — lint, tsconfig, VSCode and CI all
   excluded `repos/`; the checkout weight bought no determinism.
2. Subtree `--squash` loses the upstream SHA from any queryable place (the
   original pin `01637e41` survives only in merge commit `ecd79b5`'s message).
   Trying to re-fetch that exact SHA upstream now returns "not our ref" — the
   snapshot is unreachable, so the pin had no future value either.
3. A gitignored clone keeps history/blame of upstream available for reading
   (a tarball snapshot would not) while staying out of our tree.

The four read rules are unchanged (AGENTS.md "Effect reference clone"). The
clone tracks upstream `main`; the npm package remains compile ground truth.
History note: the old `repos/effect` blobs remain in this repo's git history —
removal from history would need git-history-surgery and is not planned.
