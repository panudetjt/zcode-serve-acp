import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import {
  AcpMethodError,
  CapabilityError,
  ChannelClosed,
  ChannelOpenError,
  ClientRequestError,
  DecodeError,
  DiscoveryError,
  InteractionError,
  RpcError,
  RpcTimeout,
  SessionError,
  SpawnError,
  renderError,
  tolerate,
} from "../src/errors.ts";

describe("Errors & tolerate helper", () => {
  test("tolerate returns success value", async () => {
    const val = await Effect.runPromise(tolerate(Effect.succeed(42)));
    expect(val).toBe(42);
  });

  test("tolerate catches failure and triggers onFail", async () => {
    let failedCause: unknown = undefined;
    const res = await Effect.runPromise(
      tolerate(Effect.fail("boom"), (cause) =>
        Effect.sync(() => {
          failedCause = cause;
        }),
      ),
    );
    expect(res).toBeUndefined();
    expect(failedCause).toBe("boom");
  });

  test("tolerate catches failure without onFail", async () => {
    const res = await Effect.runPromise(tolerate(Effect.fail("silent boom")));
    expect(res).toBeUndefined();
  });

  test("tolerate stays best-effort when the onFail handler itself fails", async () => {
    // The orElseSucceed fallback in tolerate only runs when the onFail effect
    // fails — a best-effort hook must never break the surrounding flow.
    const res = await Effect.runPromise(tolerate(Effect.fail("boom"), () => Effect.fail("onFail failed too")));
    expect(res).toBeUndefined();
  });

  test("renderError renders errors and strings", () => {
    expect(renderError(new Error("err message"))).toBe("err message");
    expect(renderError("simple string")).toBe("simple string");
  });

  test("instantiates tagged errors", () => {
    const decode = new DecodeError({ location: "loc", message: "msg" });
    expect(decode._tag).toBe("DecodeError");

    const disc = new DiscoveryError({ message: "disc" });
    expect(disc._tag).toBe("DiscoveryError");

    const spawn = new SpawnError({ bin: "bin", message: "spawn" });
    expect(spawn._tag).toBe("SpawnError");

    const cap = new CapabilityError({ message: "cap", status: 403 });
    expect(cap._tag).toBe("CapabilityError");

    const chan = new ChannelClosed({ reason: "closed" });
    expect(chan._tag).toBe("ChannelClosed");

    const chanOpen = new ChannelOpenError({ message: "open fail" });
    expect(chanOpen._tag).toBe("ChannelOpenError");

    const clientReq = new ClientRequestError({ message: "req fail" });
    expect(clientReq._tag).toBe("ClientRequestError");

    const rpcErr = new RpcError({ channel: "c", method: "m", message: "rpc" });
    expect(rpcErr._tag).toBe("RpcError");

    const rpcTime = new RpcTimeout({ channel: "c", method: "m", timeoutMs: 1000 });
    expect(rpcTime._tag).toBe("RpcTimeout");

    const sess = new SessionError({ message: "sess" });
    expect(sess._tag).toBe("SessionError");

    const act = new InteractionError({ interactionId: "act1", message: "act" });
    expect(act._tag).toBe("InteractionError");

    const acp = new AcpMethodError({ method: "meth", message: "acp" });
    expect(acp._tag).toBe("AcpMethodError");
  });
});
