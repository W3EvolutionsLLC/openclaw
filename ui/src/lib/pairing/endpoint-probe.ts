// Browser-side reachability proof for a candidate pairing endpoint: an OpenClaw
// Gateway must answer there from this page before a setup code is minted for it.
// It proves reachability and protocol shape, not Gateway identity; binding the
// challenge to this Gateway's key needs a protocol contract that does not exist yet.

/** Pre-auth frame every Gateway connection emits on open; see `src/gateway/server/ws-connection.ts`. */
const GATEWAY_CONNECT_CHALLENGE_EVENT = "connect.challenge";
const PROBE_TIMEOUT_MS = 5_000;

export type PairingEndpointProbeResult =
  | { status: "reachable" }
  | { status: "unreachable" }
  | { status: "not-a-gateway" }
  | { status: "unprovable" };

/**
 * Browsers refuse plaintext WebSockets from a secure page, so a `ws://`
 * candidate can never be proven from an HTTPS Control UI. Callers check this
 * before planning a change whose only verification would be blocked.
 */
export function canProvePairingEndpoint(
  url: string,
  pageProtocol: string = globalThis.location?.protocol ?? "http:",
): boolean {
  return pageProtocol !== "https:" || !url.startsWith("ws://");
}

type ProbeSocketListeners = {
  open: () => void;
  message: (event: { data?: unknown }) => void;
  close: () => void;
  error: () => void;
};

type PairingProbeSocket = {
  addEventListener: <K extends keyof ProbeSocketListeners>(
    type: K,
    listener: ProbeSocketListeners[K],
  ) => void;
  close: (code?: number) => void;
};

type ProbeSocketFactory = (url: string) => PairingProbeSocket;

/** Requires the whole frame the Gateway sends, not just a matching event name. */
function readChallengeFrame(data: unknown): boolean {
  if (typeof data !== "string") {
    return false;
  }
  let frame: unknown;
  try {
    frame = JSON.parse(data);
  } catch {
    return false;
  }
  if (typeof frame !== "object" || frame === null) {
    return false;
  }
  const { type, event, payload } = frame as {
    type?: unknown;
    event?: unknown;
    payload?: unknown;
  };
  if (type !== "event" || event !== GATEWAY_CONNECT_CHALLENGE_EVENT) {
    return false;
  }
  if (typeof payload !== "object" || payload === null) {
    return false;
  }
  const { nonce, ts } = payload as { nonce?: unknown; ts?: unknown };
  return typeof nonce === "string" && nonce.length > 0 && typeof ts === "number";
}

/**
 * Opens the candidate endpoint and waits for the Gateway's pre-auth challenge.
 * Nothing is ever sent, so no credential can leak to a host that only looks
 * like a Gateway; an open socket without a challenge is reported as such.
 */
export async function probePairingEndpoint(
  url: string,
  options: { openSocket?: ProbeSocketFactory; timeoutMs?: number; pageProtocol?: string } = {},
): Promise<PairingEndpointProbeResult> {
  if (
    !canProvePairingEndpoint(url, options.pageProtocol ?? globalThis.location?.protocol ?? "http:")
  ) {
    return { status: "unprovable" };
  }
  const openSocket =
    options.openSocket ??
    ((target: string) => new WebSocket(target) as unknown as PairingProbeSocket);
  let socket: PairingProbeSocket;
  try {
    socket = openSocket(url);
  } catch {
    return { status: "unreachable" };
  }
  return await new Promise<PairingEndpointProbeResult>((resolve) => {
    let opened = false;
    let settled = false;
    const settle = (result: PairingEndpointProbeResult) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      socket.close(1000);
      resolve(result);
    };
    const timer = setTimeout(
      () => settle(opened ? { status: "not-a-gateway" } : { status: "unreachable" }),
      options.timeoutMs ?? PROBE_TIMEOUT_MS,
    );
    socket.addEventListener("open", () => {
      opened = true;
    });
    socket.addEventListener("message", (event) => {
      if (readChallengeFrame(event.data)) {
        settle({ status: "reachable" });
      }
    });
    socket.addEventListener("close", () =>
      settle(opened ? { status: "not-a-gateway" } : { status: "unreachable" }),
    );
    socket.addEventListener("error", () => settle({ status: "unreachable" }));
  });
}
