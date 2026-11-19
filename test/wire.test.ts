import { describe, expect, test } from "bun:test";
import { decodeRpcMessage, deserialize, Deserializer, encodeRpcMessage, FrameSplitter, serializeValue, writeProtocolFrame } from "../src/serve/wire.ts";

describe("value codec", () => {
  test("undefined", () => {
    const out = new Deserializer(serializeValue(undefined)).next();
    expect(out).toBeUndefined();
  });
  test("string round-trip (incl. thai + unicode)", () => {
    const s = "สวัสดี hello ✨";
    const out = new Deserializer(serializeValue(s)).next();
    expect(out).toBe(s);
  });
  test("int VQL edge values", () => {
    for (const v of [0, 1, 127, 128, 16383, 16384, 2 ** 31 - 1]) {
      const out = new Deserializer(serializeValue(v)).next();
      expect(out).toBe(v);
    }
  });
  test("nested array of mixed types", () => {
    const v = [200, "abc", undefined, ["deep", 5], Buffer.from([1, 2, 3])];
    const out = new Deserializer(serializeValue(v)).next();
    expect(out).toEqual(v);
  });
  test("object round-trip + nested Uint8Array marker", () => {
    const v = { a: 1, b: "x", nested: { list: [true, null, 3.5] }, bin: new Uint8Array([9, 8, 7]) };
    const out = new Deserializer(serializeValue(v)).next() as typeof v;
    expect(out.a).toBe(1);
    expect(out.b).toBe("x");
    expect(out.nested).toEqual({ list: [true, null, 3.5] });
    expect(Buffer.from(out.bin as Uint8Array).toString()).toBe(Buffer.from([9, 8, 7]).toString());
  });
});

describe("frame layer", () => {
  test("encodeRpcMessage → decodeRpcMessage round-trip", () => {
    const header = [100, 1234, "zcode-agent", "sendPrompt"];
    const body = { sessionId: "s1", inputId: "i1" };
    const frame = encodeRpcMessage(header, body);
    const decoded = decodeRpcMessage(frame);
    expect(decoded.header).toEqual(header);
    expect(decoded.body).toEqual(body);
  });
  test("message without body", () => {
    const frame = encodeRpcMessage([200]);
    const decoded = decodeRpcMessage(frame);
    expect(decoded.header).toEqual([200]);
    expect(decoded.body).toBeUndefined();
  });
  test("FrameSplitter reassembles across chunk boundaries", () => {
    const f1 = writeProtocolFrame(1, 0, 0, serializeValue([100, 1, "ch", "m"]));
    const f2 = writeProtocolFrame(1, 0, 0, serializeValue("hello world"));
    const all = new Uint8Array(f1.byteLength + f2.byteLength);
    all.set(f1, 0);
    all.set(f2, f1.byteLength);
    const splitter = new FrameSplitter();
    const one = splitter.push(all.subarray(0, 3));
    expect(one.length).toBe(0);
    const rest = splitter.push(all.subarray(3));
    expect(rest.length).toBe(2);
  });
});
