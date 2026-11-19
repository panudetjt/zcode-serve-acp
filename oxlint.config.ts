// oxlint.config.ts — TS config (experimental in oxlint: loads via Node; run `mise run lint`).
// Effect-code families that need no type info today; the full 154-rule Effect set lives in
// effect-tsgo's oxlint presets (type-aware on TS7 — upgrade path, see docs/adr/0001 + the
// brain's effect-agent-stack source, 19 พ.ย. 2026).
const config = {
  ignorePatterns: [".repos/**", "dist/**", "node_modules/**", "test/fixtures/**"],
  categories: {
    correctness: "warn",
    perf: "warn",
    suspicious: "warn",
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
    // processEnv family — env reads should converge on the config seam
    "no-process-env": "warn",
    // globalDate family — wall-clock reads go through Clock (Effect.time), not Date.now
    "no-restricted-properties": [
      "warn",
      { object: "Date", property: "now", message: "use the Clock service instead" },
      { object: "Date", property: "parse", message: "use Schema/DateTime instead" },
    ],
  },
  overrides: [
    {
      // tests and operator scripts legitimately print to stdout / read env
      files: ["test/**", "scripts/**"],
      rules: { "no-console": "off", "no-process-env": "off" },
    },
    {
      // the designated logging sink and the env seam itself
      files: ["src/log.ts"],
      rules: { "no-console": "off", "no-process-env": "off" },
    },
  ],
};

export default config;
