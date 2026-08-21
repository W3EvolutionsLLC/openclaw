import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  loadAuthProfileStoreWithoutExternalProfiles,
  saveAuthProfileStore,
} from "openclaw/plugin-sdk/agent-runtime";
import type { ProviderAuthMethodNonInteractiveContext } from "openclaw/plugin-sdk/plugin-entry";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LLAMA_CPP_PROVIDER_ID } from "../defaults.js";
import type { LlamaServerDiscoveryResult } from "./discovery.js";
import { configureLlamaServerNonInteractive } from "./setup.js";

const discoverMock = vi.hoisted(() => vi.fn());

vi.mock("./discovery.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./discovery.js")>()),
  discoverLlamaServer: discoverMock,
}));

const PROFILE_ID = "llama-cpp:default";
let tempRoot: string;

beforeEach(async () => {
  tempRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "llama-server-auth-")));
  discoverMock.mockReset().mockResolvedValue({
    kind: "success",
    endpoint: {
      origin: "http://localhost:8080",
      inferenceBaseUrl: "http://localhost:8080/v1",
    },
    models: [
      {
        config: {
          id: "model",
          name: "model",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 8192,
          maxTokens: 2048,
        },
        status: "loaded",
        failed: false,
      },
    ],
  } satisfies LlamaServerDiscoveryResult);
});

afterEach(async () => {
  await fs.rm(tempRoot, { recursive: true, force: true });
});

describe("llama-server auth persistence", () => {
  it("clears stale failure state after successful non-interactive credential replacement", async () => {
    const agentDir = path.join(tempRoot, "agent");
    const now = Date.now();
    saveAuthProfileStore(
      {
        version: 1,
        profiles: {
          [PROFILE_ID]: {
            type: "api_key",
            provider: LLAMA_CPP_PROVIDER_ID,
            key: "stale-key",
          },
        },
        usageStats: {
          [PROFILE_ID]: {
            credentialGeneration: 3,
            errorCount: 4,
            failureCounts: { auth_permanent: 4 },
            disabledUntil: now + 60_000,
            disabledReason: "auth_permanent",
          },
        },
      },
      agentDir,
      { filterExternalAuthProfiles: false },
    );
    const ctx: ProviderAuthMethodNonInteractiveContext = {
      authChoice: "llama-cpp-existing-server",
      config: {},
      baseConfig: {},
      opts: {
        customBaseUrl: "http://localhost:8080/v1",
        llamaServerApiKey: "fresh-key",
      },
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() as never },
      agentDir,
      resolveApiKey: vi.fn(async () => ({ key: "fresh-key", source: "flag" as const })),
      toApiKeyCredential: vi.fn(() => ({
        type: "api_key" as const,
        provider: LLAMA_CPP_PROVIDER_ID,
        key: "fresh-key",
      })),
    };

    await expect(configureLlamaServerNonInteractive(ctx)).resolves.not.toBeNull();

    const persisted = loadAuthProfileStoreWithoutExternalProfiles(agentDir);
    expect(persisted.profiles[PROFILE_ID]).toMatchObject({ key: "fresh-key" });
    expect(persisted.usageStats?.[PROFILE_ID]).toEqual({
      credentialGeneration: 4,
      errorCount: 0,
    });
  });
});
