/**
 * The single seam for `process.env` reads.
 *
 * oxlint's `no-process-env` is scoped off ONLY for this file: the four drop-in
 * env vars are the binary's public contract (AGENTS.md "Architecture contracts" —
 * ZCODE_SERVE_BIN, ZCODE_SERVE_ACP_DEBUG, ZCODE_DATA_BASE_DIR, ZCODE_SERVER_ROOT),
 * plus ZCODE_SERVE_ACP_DUMP for frame debug dumps. Every other module reads env
 * through the helpers here so new call sites stay greppable in one place.
 */

export const envDebug = (): boolean => process.env.ZCODE_SERVE_ACP_DEBUG === "1";

export const envDump = (): boolean => process.env.ZCODE_SERVE_ACP_DUMP === "1";

export const envDataOverride = (): string | undefined => process.env.ZCODE_DATA_BASE_DIR;

export const envHome = (): string | undefined => process.env.HOME;

export const envServerRoot = (): string | undefined => process.env.ZCODE_SERVER_ROOT;

export const envServeBin = (): string | undefined => process.env.ZCODE_SERVE_BIN;

/** The env a spawned daemon inherits — passthrough, not a config read. */
export const childEnv = (): NodeJS.ProcessEnv => process.env;
