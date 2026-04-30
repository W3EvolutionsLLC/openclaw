import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { NodePairingRequestInput } from "../infra/node-pairing.js";
import { reconcileNodePairingOnConnect } from "./node-connect-reconcile.js";
import type { ConnectParams } from "./protocol/index.js";

function connectParams(patch: Partial<ConnectParams> = {}): ConnectParams {
  return {
    minProtocol: 1,
    maxProtocol: 1,
    client: {
      id: "node-host",
      displayName: "Mac",
      version: "dev",
      platform: "macOS",
      mode: "node",
    },
    role: "node",
    scopes: [],
    caps: ["mcpHost"],
    commands: [],
    device: {
      id: "mac-node",
      publicKey: "public-key",
      signature: "signature",
      signedAt: 1,
      nonce: "nonce",
    },
    ...patch,
  };
}

describe("reconcileNodePairingOnConnect", () => {
  it("requires a new pairing request before exposing newly declared MCP servers", async () => {
    const requestPairing = vi.fn(async (input: NodePairingRequestInput) => ({
      status: "pending" as const,
      request: {
        ...input,
        requestId: "pair-1",
        ts: 1,
      },
      created: true,
    }));

    const result = await reconcileNodePairingOnConnect({
      cfg: {} as OpenClawConfig,
      connectParams: connectParams({
        mcpServers: [
          { id: "computer-use", displayName: "Computer Use", status: "missing_permissions" },
        ],
      }),
      pairedNode: {
        nodeId: "mac-node",
        token: "token",
        caps: ["mcpHost"],
        commands: [],
        mcpServers: [],
        createdAtMs: 1,
        approvedAtMs: 1,
      },
      requestPairing,
    });

    expect(result.effectiveMcpServers).toEqual([]);
    expect(result.pendingPairing?.created).toBe(true);
    expect(requestPairing).toHaveBeenCalledWith(
      expect.objectContaining({
        mcpServers: [
          { id: "computer-use", displayName: "Computer Use", status: "missing_permissions" },
        ],
      }),
    );
  });
});
