import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requestNodePairing: vi.fn(),
}));

vi.mock("../../infra/node-pairing.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/node-pairing.js")>()),
  requestNodePairing: mocks.requestNodePairing,
}));

import { nodeHandlers } from "./nodes.js";

describe("node.pair.request", () => {
  it("forwards declared MCP servers into the pairing request", async () => {
    mocks.requestNodePairing.mockResolvedValue({
      status: "pending",
      created: true,
      request: {
        id: "pair-1",
        nodeId: "mac-node",
      },
    });
    const respond = vi.fn();
    const broadcast = vi.fn();

    await nodeHandlers["node.pair.request"]({
      req: { type: "req", id: "req-pair", method: "node.pair.request" },
      params: {
        nodeId: "mac-node",
        displayName: "Mac",
        platform: "macOS",
        caps: ["mcpHost"],
        mcpServers: [
          {
            id: "computer-use",
            displayName: "Computer Use",
            status: "ready",
            transport: "stdio",
          },
        ],
      },
      respond,
      context: { broadcast } as never,
      client: null,
      isWebchatConnect: () => false,
    });

    expect(mocks.requestNodePairing).toHaveBeenCalledWith(
      expect.objectContaining({
        nodeId: "mac-node",
        mcpServers: [
          {
            id: "computer-use",
            displayName: "Computer Use",
            status: "ready",
            transport: "stdio",
          },
        ],
      }),
    );
    expect(broadcast).toHaveBeenCalledWith(
      "node.pair.requested",
      expect.objectContaining({ nodeId: "mac-node" }),
      { dropIfSlow: true },
    );
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ status: "pending" }),
      undefined,
    );
  });
});
