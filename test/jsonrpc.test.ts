import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import {
  clientRequest,
  encodeLine,
  errorPayload,
  errorResponse,
  notification,
  parseLine,
  successResponse,
} from "../src/jsonrpc.ts";

describe("JSON-RPC stdio parsing & framing", () => {
  test("parseLine parses valid request", async () => {
    const raw = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } });
    const outcome = await Effect.runPromise(parseLine(raw));
    expect(outcome._tag).toBe("Message");
    if (outcome._tag === "Message") {
      expect(outcome.inbound._tag).toBe("Request");
      if (outcome.inbound._tag === "Request") {
        expect(outcome.inbound.request.id).toBe(1);
        expect(outcome.inbound.request.method).toBe("initialize");
        expect(outcome.inbound.request.params).toEqual({ protocolVersion: 1 });
      }
    }
  });

  test("parseLine parses valid notification", async () => {
    const raw = JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
    const outcome = await Effect.runPromise(parseLine(raw));
    expect(outcome._tag).toBe("Message");
    if (outcome._tag === "Message") {
      expect(outcome.inbound._tag).toBe("Notification");
      if (outcome.inbound._tag === "Notification") {
        expect(outcome.inbound.notification.method).toBe("notifications/initialized");
      }
    }
  });

  test("parseLine parses client response and error response", async () => {
    const rawSuccess = JSON.stringify({ jsonrpc: "2.0", id: 900001, result: { outcome: "accepted" } });
    const successOutcome = await Effect.runPromise(parseLine(rawSuccess));
    expect(successOutcome._tag).toBe("Message");
    if (successOutcome._tag === "Message" && successOutcome.inbound._tag === "Response") {
      expect(successOutcome.inbound.response.id).toBe(900001);
      expect(successOutcome.inbound.response.result).toEqual({ outcome: "accepted" });
    }

    const rawError = JSON.stringify({ jsonrpc: "2.0", id: 900002, error: { code: -32000, message: "denied" } });
    const errorOutcome = await Effect.runPromise(parseLine(rawError));
    expect(errorOutcome._tag).toBe("Message");
    if (errorOutcome._tag === "Message" && errorOutcome.inbound._tag === "Response") {
      expect(errorOutcome.inbound.response.id).toBe(900002);
      expect(errorOutcome.inbound.response.error?.message).toBe("denied");
    }
  });

  test("parseLine handles malformed JSON and ignored lines", async () => {
    const malformed = await Effect.runPromise(parseLine("not json"));
    expect(malformed._tag).toBe("Malformed");

    const ignored = await Effect.runPromise(parseLine(JSON.stringify({ someRandomField: 123 })));
    expect(ignored._tag).toBe("Ignored");
  });

  test("envelope helpers serialize correctly", () => {
    const req = clientRequest(10, "session/request_permission", { foo: "bar" });
    expect(req).toEqual({ jsonrpc: "2.0", id: 10, method: "session/request_permission", params: { foo: "bar" } });

    const notif = notification("session/update", { text: "hello" });
    expect(notif).toEqual({ jsonrpc: "2.0", method: "session/update", params: { text: "hello" } });

    const resp = successResponse(5, { ok: true });
    expect(resp).toEqual({ jsonrpc: "2.0", id: 5, result: { ok: true } });

    const err = errorResponse(5, errorPayload("something broke"));
    expect(err).toEqual({ jsonrpc: "2.0", id: 5, error: { code: -32000, message: "something broke" } });

    expect(encodeLine({ a: 1 })).toBe('{"a":1}\n');
  });
});
