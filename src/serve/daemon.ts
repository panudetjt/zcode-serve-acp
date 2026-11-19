/**
 * `zcode serve` daemon discovery + startup.
 *
 * Contract (ground-truthed against server-core.js 3.18.2 + the owner's PR
 * #34713): status at `~/.zcode/server/run/status.json` (trust `state ===
 * "ready"` + probe `GET /api/server-info`), ingress token at
 * `~/.zcode/server/run/ingress-token`, host capability via
 * `POST /api/rpc-host-capability` (Bearer token; 30s TTL, single use — fetch
 * right before the WS upgrade). If no ready daemon: spawn `zcode serve`
 * detached and poll (250ms, 30s budget). The daemon outlives the bridge.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export interface ServerStatus {
  state: string;
  host: string;
  port: number;
  version?: string;
  pid?: number;
}

export interface DaemonConnection {
  status: ServerStatus;
  token: string;
  /** ws:// URL for /ws/host with capability header — fetch fresh capability per connect */
  getCapability: () => Promise<string>;
  wsPath: string;
}

const STARTUP_TIMEOUT_MS = 30_000;
const STARTUP_POLL_MS = 250;
const PROBE_TIMEOUT_MS = 2_000;

export function dataRoot(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (env.ZCODE_DATA_BASE_DIR) return env.ZCODE_DATA_BASE_DIR;
  return env.HOME ?? os.homedir();
}

function serverRoot(env: NodeJS.ProcessEnv): string | undefined {
  if (env.ZCODE_SERVER_ROOT) return env.ZCODE_SERVER_ROOT;
  const root = dataRoot(env);
  return root === undefined ? undefined : path.join(root, ".zcode", "server");
}

export function resolveServeBinary(env: NodeJS.ProcessEnv = process.env): string {
  if (env.ZCODE_SERVE_BIN) return env.ZCODE_SERVE_BIN;
  const candidates = [
    path.join(os.homedir(), ".zcode", "server", "bin", "zcode"),
    "/usr/local/bin/zcode",
  ];
  for (const p of candidates) if (existsSync(p)) return p;
  return "zcode"; // last resort: hope PATH has it
}

async function probeServerInfo(host: string, port: number, token: string): Promise<boolean> {
  try {
    const res = await fetch(`http://${host}:${port}/api/server-info`, {
      headers: token ? { authorization: `Bearer ${token}` } : undefined,
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    return res.status >= 200 && res.status < 300;
  } catch {
    return false;
  }
}

function readStatus(serverRootDir: string): ServerStatus | undefined {
  const file = path.join(serverRootDir, "run", "status.json");
  if (!existsSync(file)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as ServerStatus;
    if (parsed.state !== "ready" || typeof parsed.port !== "number") return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

function readToken(serverRootDir: string): string {
  const file = path.join(serverRootDir, "run", "ingress-token");
  if (!existsSync(file)) return "";
  return readFileSync(file, "utf8").trim();
}

async function waitForReadyDaemon(
  serverRootDir: string,
  env: NodeJS.ProcessEnv,
  log?: (...parts: unknown[]) => void,
): Promise<{ status: ServerStatus; token: string }> {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  for (;;) {
    const status = readStatus(serverRootDir);
    const token = readToken(serverRootDir);
    if (status && (await probeServerInfo(status.host, status.port, token))) {
      return { status, token };
    }
    if (Date.now() > deadline) {
      throw new Error("zcode serve did not report a ready daemon (30s)");
    }
    await new Promise((r) => setTimeout(r, STARTUP_POLL_MS));
    if (log && status) log(`[daemon] waiting: state=${status.state}`);
  }
}

export async function connectDaemon(
  env: NodeJS.ProcessEnv = process.env,
  log?: (...parts: unknown[]) => void,
): Promise<DaemonConnection> {
  const rootDir = serverRoot(env);
  if (rootDir === undefined) throw new Error("cannot resolve zcode server root (no HOME?)");

  let status = readStatus(rootDir);
  let token = readToken(rootDir);
  let ready = status ? await probeServerInfo(status.host, status.port, token) : false;

  if (!ready) {
    const bin = resolveServeBinary(env);
    log?.(`[daemon] no ready daemon — spawning ${bin} serve`);
    const child = spawn(bin, ["serve"], {
      env,
      detached: true,
      stdio: "ignore",
    });
    // The daemon must outlive the bridge — fully detach.
    child.unref();
    const { status: s, token: t } = await waitForReadyDaemon(rootDir, env, log);
    status = s;
    token = t;
  } else {
    log?.(`[daemon] attaching to ready daemon ${status!.host}:${status!.port}`);
  }

  return {
    status: status!,
    token,
    wsPath: "/ws/host",
    async getCapability() {
      const res = await fetch(`http://${status!.host}:${status!.port}/api/rpc-host-capability`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        throw new Error(`zcode server refused the host grant (HTTP ${res.status})`);
      }
      const body = (await res.json()) as { capability: string; expiresAt?: number };
      if (!body.capability) throw new Error("zcode server capability response missing capability");
      return body.capability;
    },
  };
}
