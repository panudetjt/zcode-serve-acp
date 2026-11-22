// oxlint.config.ts — TS config (node-backed; `mise run lint`).
// Effect rules come from @effect/tsgo's recommended preset (type-aware via the patched
// tsgolint — Effect Devtools docs, /docs/v4/getting-started/devtools). Generic families
// below cover what Effect rules don't. Installed per docs: `effect-tsgo patch --oxlint`
// in package.json prepare.
import { recommended } from "@effect/tsgo/oxlint-presets"
import { defineConfig } from "oxlint"

const config = defineConfig({
  extends: [recommended],
  ignorePatterns: [".repos/**", "dist/**", "node_modules/**", "test/fixtures/**"],
  categories: {
    correctness: "warn",
    perf: "warn",
    suspicious: "warn"
  },
  plugins: ["node"],
  rules: {
    // Effect's tagged unions carry the `_tag` discriminant everywhere (vendored source
    // included) — this rule fights the house style, so it stays off.
    "no-underscore-dangle": "off",
    // real shadowing exists (9 hits) but is style noise for now — revisit after a cleanup pass
    "no-shadow": "off",
    // globalConsole family — domain code logs via the Logger service (src/log.ts is the sink)
    "no-console": "warn",
    // processEnv family — env reads converge on the AppConfig service (src/config.ts)
    "no-process-env": "warn",
    // globalDate family — wall-clock reads go through the Clock service
    "no-restricted-properties": [
      "warn",
      { object: "Date", property: "now", message: "use the Clock service instead" },
      { object: "Date", property: "parse", message: "use Schema/DateTime instead" }
    ],
    // the platform surfaces (effect/FileSystem, effect/http, effect/socket, effect/Stdio)
    // are this project's chosen architecture (ADR 0002) — the unstable allowlist lives in
    // tsconfig.json plugins (LSP side); oxlint's rule has no per-API options, so it stays off here
    "effecttsgo/unstable-api-usage": "off"
  },
  overrides: [
    {
      // tests and operator scripts legitimately print to stdout / read env
      files: ["test/**", "scripts/**"],
      rules: {
        "no-console": "off",
        "no-process-env": "off",
        // tests are their own entry points: each test provides its layers directly
        "effecttsgo/strict-effect-provide": "off",
        "effecttsgo/multiple-effect-provide": "off",
        "effecttsgo/provide-layer-succeed-to-provide-service": "off",
        // assertion styles specific to test fixtures
        "effecttsgo/global-error-in-effect-failure": "off",
        "effecttsgo/effect-succeed-with-undefined": "off",
        "effecttsgo/prefer-typed-schema-decoder": "off",
        // typed error channels land with the errors refactor (deferred)
        "effecttsgo/any-unknown-in-error-context": "off"
      }
    },
    {
      // application entry point — the rule allows provide-at-entry
      files: ["src/bin.ts"],
      rules: { "effecttsgo/strict-effect-provide": "off" }
    },
    {
      // the designated logging sink + the debug seam it reads at layer build time
      files: ["src/log.ts"],
      rules: { "no-console": "off", "no-process-env": "off" }
    },
    {
      // the only file allowed to touch process.env (see its header)
      files: ["src/config.ts"],
      rules: { "no-process-env": "off" }
    }
  ]
})

export default config
