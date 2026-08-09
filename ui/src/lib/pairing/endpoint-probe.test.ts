import { describe, expect, it, vi } from "vitest";
import { canProvePairingEndpoint, probePairingEndpoint } from "./endpoint-probe.ts";

// The socket shape is an implementation detail of the probe; derive it from the
// public signature so this suite cannot drift from the contract it exercises.
type ProbeSocket = ReturnType<
  NonNullable<NonNullable<Parameters<typeof probePairingEndpoint>[1]>["openSocket"]>
>;

type Listeners = {
  open: Array<() => void>;
  message: Array<(event: { data?: unknown }) => void>;
  close: Array<() => void>;
  error: Array<() => void>;
};

function createFakeSocket() {
  const listeners: Listeners = { open: [], message: [], close: [], error: [] };
  const close = vi.fn();
  const sent: unknown[] = [];
  const socket = {
    addEventListener: (type: keyof Listeners, listener: unknown) => {
      (listeners[type] as unknown[]).push(listener);
    },
    close,
    send: (data: unknown) => sent.push(data),
  } as unknown as ProbeSocket;
  return {
    socket,
    close,
    sent,
    emit: {
      open: () => listeners.open.forEach((listener) => listener()),
      message: (data: unknown) => listeners.message.forEach((listener) => listener({ data })),
      close: () => listeners.close.forEach((listener) => listener()),
      error: () => listeners.error.forEach((listener) => listener()),
    },
  };
}

describe("probePairingEndpoint", () => {
  it("proves reachability from the Gateway challenge without sending anything", async () => {
    const fake = createFakeSocket();
    const pending = probePairingEndpoint("wss://gateway.example.com", {
      openSocket: () => fake.socket,
    });
    fake.emit.open();
    fake.emit.message(
      JSON.stringify({
        type: "event",
        event: "connect.challenge",
        payload: { nonce: "abc", ts: 1 },
      }),
    );

    await expect(pending).resolves.toEqual({ status: "reachable" });
    expect(fake.sent).toEqual([]);
    expect(fake.close).toHaveBeenCalledWith(1000);
  });

  it.each([
    {
      name: "reports an endpoint that never opens as unreachable",
      act: (fake: ReturnType<typeof createFakeSocket>) => fake.emit.error(),
      expected: { status: "unreachable" },
    },
    {
      name: "reports a host that answers without a challenge as not a gateway",
      act: (fake: ReturnType<typeof createFakeSocket>) => {
        fake.emit.open();
        fake.emit.message("not-json");
        fake.emit.close();
      },
      expected: { status: "not-a-gateway" },
    },
    {
      name: "rejects a peer that echoes the event name without the Gateway frame",
      act: (fake: ReturnType<typeof createFakeSocket>) => {
        fake.emit.open();
        fake.emit.message(JSON.stringify({ event: "connect.challenge" }));
        fake.emit.message(JSON.stringify({ type: "event", event: "connect.challenge" }));
        fake.emit.message(
          JSON.stringify({ type: "event", event: "connect.challenge", payload: { nonce: "" } }),
        );
        fake.emit.close();
      },
      expected: { status: "not-a-gateway" },
    },
  ])("$name", async ({ act, expected }) => {
    const fake = createFakeSocket();
    const pending = probePairingEndpoint("wss://gateway.example.com", {
      openSocket: () => fake.socket,
    });
    act(fake);

    await expect(pending).resolves.toEqual(expected);
  });

  it("stops waiting once the probe budget expires", async () => {
    const fake = createFakeSocket();
    const pending = probePairingEndpoint("wss://gateway.example.com", {
      openSocket: () => fake.socket,
      timeoutMs: 1,
    });
    fake.emit.open();

    await expect(pending).resolves.toEqual({ status: "not-a-gateway" });
    expect(fake.close).toHaveBeenCalledWith(1000);
  });

  it("treats a socket that cannot be constructed as unreachable", async () => {
    await expect(
      probePairingEndpoint("wss://gateway.example.com", {
        openSocket: () => {
          throw new Error("blocked by mixed content policy");
        },
      }),
    ).resolves.toEqual({ status: "unreachable" });
  });

  it("refuses a plaintext candidate a secure page can never open", async () => {
    const openSocket = vi.fn();

    expect(canProvePairingEndpoint("ws://192.168.1.20:18789", "https:")).toBe(false);
    expect(canProvePairingEndpoint("ws://192.168.1.20:18789", "http:")).toBe(true);
    expect(canProvePairingEndpoint("wss://gateway.example.com", "https:")).toBe(true);
    await expect(
      probePairingEndpoint("ws://192.168.1.20:18789", { openSocket, pageProtocol: "https:" }),
    ).resolves.toEqual({ status: "unprovable" });
    expect(openSocket).not.toHaveBeenCalled();
  });
});
