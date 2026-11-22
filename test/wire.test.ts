import { describe, expect, test } from "bun:test"
import {
  decodeRpcMessage,
  deserialize,
  Deserializer,
  encodeRpcMessage,
  FrameSplitter,
  serializeValue,
  writeProtocolFrame
} from "../src/serve/wire.ts"

describe("value codec", () => {
  test("undefined", () => {
    const out = new Deserializer(serializeValue(undefined)).next()
    expect(out).toBeUndefined()
  })
  test("string round-trip (incl. thai + unicode)", () => {
    const s = "สวัสดี hello ✨"
    const out = new Deserializer(serializeValue(s)).next()
    expect(out).toBe(s)
  })
  test("int VQL edge values", () => {
    for (const v of [0, 1, 127, 128, 16383, 16384, 2 ** 31 - 1]) {
      const out = new Deserializer(serializeValue(v)).next()
      expect(out).toBe(v)
    }
  })
  test("nested array of mixed types", () => {
    const v = [200, "abc", undefined, ["deep", 5], Buffer.from([1, 2, 3])]
    const out = new Deserializer(serializeValue(v)).next()
    expect(out).toEqual(v)
  })
  test("object round-trip + nested Uint8Array marker", () => {
    const v = { a: 1, b: "x", nested: { list: [true, null, 3.5] }, bin: new Uint8Array([9, 8, 7]) }
    const out = new Deserializer(serializeValue(v)).next() as typeof v
    expect(out.a).toBe(1)
    expect(out.b).toBe("x")
    expect(out.nested).toEqual({ list: [true, null, 3.5] })
    expect(Buffer.from(out.bin as Uint8Array).toString()).toBe(Buffer.from([9, 8, 7]).toString())
  })
})

describe("frame layer", () => {
  test("encodeRpcMessage → decodeRpcMessage round-trip", () => {
    const header = [100, 1234, "zcode-agent", "sendPrompt"]
    const body = { sessionId: "s1", inputId: "i1" }
    const frame = encodeRpcMessage(header, body)
    const decoded = decodeRpcMessage(frame)
    expect(decoded.header).toEqual(header)
    expect(decoded.body).toEqual(body)
  })
  test("message without body", () => {
    const frame = encodeRpcMessage([200])
    const decoded = decodeRpcMessage(frame)
    expect(decoded.header).toEqual([200])
    expect(decoded.body).toBeUndefined()
  })
  test("FrameSplitter reassembles across chunk boundaries and handles multi-chunk peek", () => {
    const f1 = writeProtocolFrame(1, 0, 0, serializeValue([100, 1, "ch", "m"]))
    const f2 = writeProtocolFrame(1, 0, 0, serializeValue("hello world"))
    const all = new Uint8Array(f1.byteLength + f2.byteLength)
    all.set(f1, 0)
    all.set(f2, f1.byteLength)
    const splitter = new FrameSplitter()
    const one = splitter.push(all.subarray(0, 3))
    expect(one.length).toBe(0)
    // Push chunks smaller than FRAME_HEADER_BYTES (13) to exercise multi-chunk peek
    splitter.push(all.subarray(3, 8))
    splitter.push(all.subarray(8, 14))
    const rest = splitter.push(all.subarray(14))
    expect(rest.length).toBe(2)
  })

  test("deserialize helper and buffer tags", () => {
    const buf = Buffer.from([10, 20, 30])
    const val = deserialize(serializeValue(buf))
    expect(val).toBeDefined()

    // Unknown value tag throws DecodeError
    expect(() => deserialize(new Uint8Array([99]))).toThrow()

    // Truncated buffer need(n) throws DecodeError
    // tag 1 = string, length = 10, but only 2 bytes provided
    expect(() => deserialize(new Uint8Array([1, 10, 65, 66]))).toThrow()
  })

  test("decodeRpcMessage edge cases: non-regular frame, non-array header, and truncated body", () => {
    // Non-regular frame (kind !== 1)
    const pingFrame = writeProtocolFrame(2, 0, 0, new Uint8Array([]))
    const decodedPing = decodeRpcMessage(pingFrame)
    expect(decodedPing.header).toEqual([2])
    expect(decodedPing.body).toBeUndefined()

    // Header is not an array -> throws DecodeError
    const badHeaderFrame = writeProtocolFrame(1, 0, 0, serializeValue("not an array"))
    expect(() => decodeRpcMessage(badHeaderFrame)).toThrow()

    // Truncated body in decodeRpcMessage -> catches and sets body to undefined
    const headerBytes = serializeValue([100, 1])
    const truncatedBodyFrame = writeProtocolFrame(
      1,
      0,
      0,
      new Uint8Array([...headerBytes, 1, 10, 65]) // string tag with length 10 but truncated
    )
    const decodedTruncated = decodeRpcMessage(truncatedBodyFrame)
    expect(decodedTruncated.header).toEqual([100, 1])
    expect(decodedTruncated.body).toBeUndefined()
  })
})
