/**
 * Wire codec for the `zcode serve` channel protocol — ported unchanged from
 * the pre-rewrite bridge, which read it from the local server-core.js
 * (ZCode Server runtime 3.18.2, read 2026-11-18):
 *
 *   - SocketProtocol frame: [type u8][id u32BE][ack u32BE][len u32BE][body],
 *     only type 1 (Regular) carries an RPC body.
 *   - RPC value encoding (serialize/deserialize): 1-byte tag
 *     (0 Undefined, 1 String, 2 Buffer, 3 VSBuffer, 4 Array, 5 Object, 6 Int),
 *     lengths/counts as unsigned LEB128-ish VQL (7 bits per byte, little
 *     endian, high bit = continuation), Objects as JSON text with nested
 *     Uint8Arrays marked `__zcode_rpc_nested_uint8array_v1`.
 *   - Channel RPC messages (header array + optional body):
 *     Initialize=200, Promise(call)=100 [100,id,channelName,name]+arg,
 *     PromiseCancel=101, EventListen=102, EventDispose=103,
 *     PromiseSuccess=201, PromiseError=202, PromiseErrorObj=203,
 *     EventFire=204, EventError=205.  The server sends [200] on connect.
 *
 * This codec is intentionally hand-rolled (NOT expressed in Schema) — the
 * varint/tag shapes come from reverse-engineered daemon internals. Every
 * parse failure raises the typed `DecodeError`.
 */
import { DecodeError } from "../errors.ts";

// ---------- SocketProtocol frames ----------

export const FRAME_HEADER_BYTES = 13;
export const FRAME_KIND_REGULAR = 1;

export function writeProtocolFrame(type: number, id: number, ack: number, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(FRAME_HEADER_BYTES + body.byteLength);
  const view = new DataView(out.buffer);
  out[0] = type;
  view.setUint32(1, id, false);
  view.setUint32(5, ack, false);
  view.setUint32(9, body.byteLength, false);
  out.set(body, FRAME_HEADER_BYTES);
  return out;
}

/** Incremental frame splitter over a byte stream. */
export class FrameSplitter {
  private chunks: Uint8Array[] = [];
  private length = 0;

  push(data: Uint8Array): Uint8Array[] {
    this.chunks.push(data);
    this.length += data.byteLength;
    const frames: Uint8Array[] = [];
    for (;;) {
      if (this.length < FRAME_HEADER_BYTES) break;
      const head = this.peek(FRAME_HEADER_BYTES);
      const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
      const bodyLen = view.getUint32(9, false);
      const total = FRAME_HEADER_BYTES + bodyLen;
      if (this.length < total) break;
      frames.push(this.take(total));
    }
    return frames;
  }

  private peek(n: number): Uint8Array {
    if (this.chunks[0]!.byteLength >= n) return this.chunks[0]!.subarray(0, n);
    const out = new Uint8Array(n);
    let filled = 0;
    for (const c of this.chunks) {
      const take = Math.min(c.byteLength, n - filled);
      out.set(c.subarray(0, take), filled);
      filled += take;
      if (filled === n) break;
    }
    return out;
  }

  private take(n: number): Uint8Array {
    const out = new Uint8Array(n);
    let filled = 0;
    while (filled < n) {
      const first = this.chunks[0]!;
      const take = Math.min(first.byteLength, n - filled);
      out.set(first.subarray(0, take), filled);
      filled += take;
      if (take === first.byteLength) {
        this.chunks.shift();
      } else {
        this.chunks[0] = first.subarray(take);
      }
    }
    this.length -= n;
    return out;
  }
}

// ---------- value codec ----------

const TAG_UNDEFINED = 0;
const TAG_STRING = 1;
const TAG_BUFFER = 2;
const TAG_VSBUFFER = 3;
const TAG_ARRAY = 4;
const TAG_OBJECT = 5;
const TAG_INT = 6;

const NESTED_U8_MARKER = "__zcode_rpc_nested_uint8array_v1";
const NESTED_U8_B64 = "base64";

function writeVQL(out: number[], value: number): void {
  // unsigned 32-bit, 7 bits per byte, little endian, high bit = continuation
  if (value === 0) {
    out.push(0);
    return;
  }
  let v = value >>> 0;
  while (v !== 0) {
    let byte = v & 127;
    v = v >>> 7;
    if (v > 0) byte |= 128;
    out.push(byte);
  }
}

function replacer(this: Record<string, unknown>, key: string, value: unknown): unknown {
  const original = this?.[key];
  if (original instanceof Uint8Array) {
    return { [NESTED_U8_MARKER]: true, [NESTED_U8_B64]: Buffer.from(original).toString("base64") };
  }
  return value;
}

function reviver(_key: string, value: unknown): unknown {
  if (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (value as Record<string, unknown>)[NESTED_U8_MARKER] === true &&
    typeof (value as Record<string, unknown>)[NESTED_U8_B64] === "string" &&
    Object.keys(value).length === 2
  ) {
    const b64 = (value as Record<string, unknown>)[NESTED_U8_B64];
    return new Uint8Array(Buffer.from(typeof b64 === "string" ? b64 : "", "base64"));
  }
  return value;
}

export function serializeValue(data: unknown): Uint8Array {
  const out: number[] = [];
  const write = (bytes: number[] | Uint8Array) => {
    for (const b of bytes as number[]) out.push(b);
  };
  const writeLen = (n: number) => writeVQL(out, n);
  const put = (tag: number, bytes: Uint8Array) => {
    out.push(tag);
    writeLen(bytes.byteLength);
    write(bytes);
  };
  const walk = (data: unknown): void => {
    if (data === undefined) {
      out.push(TAG_UNDEFINED);
    } else if (typeof data === "string") {
      put(TAG_STRING, Buffer.from(data, "utf8"));
    } else if (data instanceof Uint8Array) {
      put(TAG_BUFFER, data);
    } else if (Array.isArray(data)) {
      out.push(TAG_ARRAY);
      writeLen(data.length);
      for (const el of data) walk(el);
    } else if (typeof data === "number" && Number.isInteger(data) && (data | 0) === data) {
      out.push(TAG_INT);
      writeVQL(out, data);
    } else {
      put(TAG_OBJECT, Buffer.from(JSON.stringify(data, replacer), "utf8"));
    }
  };
  walk(data);
  return new Uint8Array(out);
}

export class Deserializer {
  constructor(
    private readonly buf: Uint8Array,
    private pos = 0,
  ) {}

  private need(n: number): void {
    if (this.pos + n > this.buf.byteLength) {
      throw new DecodeError({
        location: "wire/value",
        message: `rpc codec: need ${n} bytes at ${this.pos}, have ${this.buf.byteLength - this.pos}`,
      });
    }
  }

  private readVQL(): number {
    this.need(1);
    let value = 0;
    for (let n = 0; ; n += 7) {
      const next = this.buf[this.pos++]!;
      value |= (next & 127) << n;
      if (!(next & 128)) return value >>> 0;
    }
  }

  private readBytes(n: number): Uint8Array {
    this.need(n);
    const out = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }

  next(): unknown {
    const tag = this.buf[this.pos++]!;
    switch (tag) {
      case TAG_UNDEFINED:
        return undefined;
      case TAG_STRING:
        return Buffer.from(this.readBytes(this.readVQL())).toString("utf8");
      case TAG_BUFFER:
      case TAG_VSBUFFER:
        return this.readBytes(this.readVQL());
      case TAG_ARRAY: {
        const length = this.readVQL();
        const result: unknown[] = [];
        for (let i = 0; i < length; i++) result.push(this.next());
        return result;
      }
      case TAG_INT:
        return this.readVQL();
      case TAG_OBJECT:
        return JSON.parse(Buffer.from(this.readBytes(this.readVQL())).toString("utf8"), reviver);
      default:
        throw new DecodeError({ location: "wire/value", message: `rpc codec: unknown value tag ${tag}` });
    }
  }
}

/** Decode a single encoded value buffer (exported for tests). */
export function deserialize(buf: Uint8Array): unknown {
  return new Deserializer(buf).next();
}

// ---------- channel RPC messages ----------

export const MSG = {
  Promise: 100,
  PromiseCancel: 101,
  EventListen: 102,
  EventDispose: 103,
  Initialize: 200,
  PromiseSuccess: 201,
  PromiseError: 202,
  PromiseErrorObj: 203,
  EventFire: 204,
  EventError: 205,
} as const;

export type RpcHeader = unknown[];

export function encodeRpcMessage(header: RpcHeader, body?: unknown): Uint8Array {
  const frame = new Uint8Array([...serializeValue(header), ...serializeValue(body)]);
  return writeProtocolFrame(FRAME_KIND_REGULAR, 0, 0, frame);
}

export interface DecodedRpc {
  header: RpcHeader;
  body: unknown;
}

export function decodeRpcMessage(frame: Uint8Array): DecodedRpc {
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  const kind = view.getUint8(0);
  if (kind !== FRAME_KIND_REGULAR) return { header: [kind], body: undefined };
  const body = frame.subarray(FRAME_HEADER_BYTES);
  const reader = new Deserializer(body);
  const header = decodeHeader(reader);
  let rest: unknown;
  try {
    rest = reader.next();
  } catch {
    rest = undefined;
  }
  return { header, body: rest };
}

function decodeHeader(reader: Deserializer): RpcHeader {
  const value = reader.next();
  if (!Array.isArray(value)) {
    throw new DecodeError({ location: "wire/header", message: "rpc codec: header is not an array" });
  }
  return value;
}
