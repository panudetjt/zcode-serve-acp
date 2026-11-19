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
