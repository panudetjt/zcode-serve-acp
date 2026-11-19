import { decodeRpcMessage, encodeRpcMessage, FrameSplitter, MSG } from "./wire.ts";

export type ChannelEventListener = (data: unknown) => void;
export type ServerRequestHandler = (channelName: string, name: string, arg: unknown) => Promise<unknown>;

export interface ChannelClientOptions {
  url: string;
  /** e.g. `x-zcode-rpc-host-capability: <capability>` */
  headers?: Record<string, string>;
  /** ms to wait for the server's [200] Initialize (default 15_000, per upstream client) */
  initializeTimeoutMs?: number;
  /** called for server→client requests (e.g. interaction requests); null = reject */
  onRequest?: ServerRequestHandler;
  onClose?: (reason: string) => void;
  /** debug logger (stderr — stdout is the ACP channel) */
  log?: (...parts: unknown[]) => void;
}

/**
 * Channel RPC client over the binary WS protocol: `call("zcode-agent", method, arg)`
 * mirrors the upstream ChannelClient (CALL=100 / RESULT=201 / ERROR=202 / EVENT=204).
 * The daemon sends [200] right after the socket opens; we also run a ChannelServer
 * on the same socket so the daemon can call US back (interaction requests).
 */
export class ChannelClient {
  private nextId = 1_000;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: Timer }>();
  private listeners = new Map<number, { event: string; handler: ChannelEventListener }>();
  private eventByKey = new Map<string, { id: number; handler: ChannelEventListener }>();
  private splitter = new FrameSplitter();
  private ws: WebSocket | null = null;
  private initialized: Promise<void>;
  private settled = false;
  readonly closed: Promise<string>;

  constructor(private readonly opts: ChannelClientOptions) {
    this.initialized = new Promise((resolve, reject) => {
      this.initResolve = resolve;
      this.initReject = reject;
    });
    this.closed = new Promise((resolve) => {
      this.closedResolve = resolve;
    });
    this.open();
  }

  private initResolve!: () => void;
  private initReject!: (e: Error) => void;
  private closedResolve!: (reason: string) => void;

  private open(): void {
    const { url, headers = {}, initializeTimeoutMs = 15_000, log } = this.opts;
    const ws = new WebSocket(url, { headers } as never);
    this.ws = ws;
    const timeout = setTimeout(() => {
      this.initReject(new Error("zcode server channel handshake timed out"));
      ws.close();
    }, initializeTimeoutMs);

    ws.addEventListener("open", () => {
      clearTimeout(timeout);
      // (Bun fires open after headers are sent; the daemon now sends [200].)
    });
    ws.addEventListener("message", (ev) => {
      const data =
        typeof (ev as { data?: unknown }).data === "string"
          ? Buffer.from((ev as { data: string }).data, "utf8")
          : new Uint8Array((ev as { data: ArrayBuffer | Uint8Array }).data);
      for (const frame of this.splitter.push(data)) this.handleFrame(frame);
    });
    ws.addEventListener("close", () => {
      const reason = "zcode server channel closed";
      this.failAll(reason);
      this.opts.onClose?.(reason);
      this.closedResolve(reason);
    });
    ws.addEventListener("error", () => {
      const reason = "zcode server channel error";
      this.failAll(reason);
      this.opts.onClose?.(reason);
      this.closedResolve(reason);
    });
    log?.(`[channel] connecting ${url}`);
  }

  private handleFrame(frame: Uint8Array): void {
    const { header, body } = decodeRpcMessage(frame);
    const type = header[0];
    if (type === MSG.Initialize) {
      this.initResolve();
      return;
    }
    const id = header[1] as number;
    if (type === MSG.PromiseSuccess) {
      this.pending.get(id)?.resolve(body);
      this.pending.delete(id);
      return;
    }
    if (type === MSG.PromiseError || type === MSG.PromiseErrorObj) {
      const payload = body as { message?: string } | undefined;
      this.pending
        .get(id)
        ?.reject(new Error(payload?.message ?? `zcode channel error (type ${type})`));
      this.pending.delete(id);
      return;
    }
    if (type === MSG.EventFire) {
      const listener = this.listeners.get(id);
      listener?.handler(body);
      return;
    }
    if (type === MSG.EventError) {
      this.opts.log?.(`[channel] event error id=${id}`, body);
      return;
    }
    if (type === MSG.Promise) {
      // server→client request (e.g. interaction requests): [100, id, channelName, name]
      const [, , channelName, name] = header as [number, number, string, string];
      void this.handleServerRequest(id, channelName, name, body);
      return;
    }
    this.opts.log?.(`[channel] unhandled frame type ${type}`, header);
  }

  private async handleServerRequest(id: number, channelName: string, name: string, arg: unknown): Promise<void> {
    let result: unknown;
    try {
      if (!this.opts.onRequest) throw new Error(`no handler for server request ${channelName}.${name}`);
      result = await this.opts.onRequest(channelName, name, arg);
    } catch (error) {
      const payload = {
        message: error instanceof Error ? error.message : String(error),
        name: error instanceof Error ? error.name : "Error",
      };
      this.send(encodeRpcMessage([MSG.PromiseErrorObj, id], payload));
      return;
    }
    this.send(encodeRpcMessage([MSG.PromiseSuccess, id], result));
  }

  private failAll(reason: string): void {
    if (this.settled) return;
    this.settled = true;
    const error = new Error(reason);
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(error);
    }
    this.pending.clear();
    this.initReject(error);
  }

  private send(bytes: Uint8Array): void {
    if (!this.ws || this.ws.readyState !== this.ws.OPEN) {
      throw new Error("zcode server channel is not open");
    }
    this.ws.send(bytes);
  }

  async ready(): Promise<void> {
    return this.initialized;
  }

  /** `channel.call("zcode-agent", "sendPrompt", arg)` equivalent. */
  call<T = unknown>(channelName: string, method: string, arg?: unknown, timeoutMs = 30_000): Promise<T> {
    const id = this.nextId++;
    const promise = new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.send(encodeRpcMessage([MSG.PromiseCancel, id]));
        reject(new Error(`zcode channel call ${channelName}.${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject: reject as (e: Error) => void,
        timer,
      });
    });
    this.send(encodeRpcMessage([MSG.Promise, id, channelName, method], [arg]));
    return promise;
  }

  /** `channel.listen("zcode-agent", event, arg, handler)` equivalent. Returns a dispose fn. */
  listen(channelName: string, event: string, arg: unknown, handler: ChannelEventListener): () => void {
    const id = this.nextId++;
    this.listeners.set(id, { event, handler });
    const key = `${channelName}:${event}`;
    this.eventByKey.set(key, { id, handler });
    this.send(encodeRpcMessage([MSG.EventListen, id, channelName, event], arg ?? undefined));
    return () => {
      this.listeners.delete(id);
      this.eventByKey.delete(key);
      try {
        this.send(encodeRpcMessage([MSG.EventDispose, id]));
      } catch {
        /* channel already closed */
      }
    };
  }

  close(): void {
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
  }
}
