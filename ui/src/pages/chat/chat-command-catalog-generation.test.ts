// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import {
  invalidateChatMetadataStore,
  rememberChatMetadata,
  revalidateChatMetadata,
} from "../../lib/chat/chat-metadata-store.ts";
import type { SlashCommandDef } from "../../lib/chat/commands.ts";
import { loadSlashCommandCatalogResult } from "./chat-commands.ts";

function remoteCommand(name: string, description: string) {
  return {
    name,
    textAliases: [`/${name}`],
    description,
    source: "plugin" as const,
    scope: "text" as const,
    acceptsArgs: false,
  };
}

async function loadSlashCommandCatalog(
  client: GatewayBrowserClient,
  agentId: string | undefined,
  options: { awaitMetadataRevalidation?: boolean; refreshRemote?: boolean } = {},
): Promise<readonly SlashCommandDef[]> {
  return (await loadSlashCommandCatalogResult(client, agentId, options)).commands;
}

describe("slash command catalog generations", () => {
  it("does not resurrect a remote cache after metadata becomes authoritative", async () => {
    let resolveFirstMetadata: ((value: unknown) => void) | undefined;
    let rejectSecondMetadata: ((reason?: unknown) => void) | undefined;
    const firstMetadata = new Promise((resolve) => {
      resolveFirstMetadata = resolve;
    });
    const secondMetadata = new Promise((_, reject) => {
      rejectSecondMetadata = reject;
    });
    let metadataRequestCount = 0;
    let remoteRequestCount = 0;
    const request = vi.fn((method: string) => {
      if (method === "chat.metadata") {
        metadataRequestCount += 1;
        return metadataRequestCount === 1 ? firstMetadata : secondMetadata;
      }
      remoteRequestCount += 1;
      return remoteRequestCount === 1
        ? Promise.resolve({
            commands: [remoteCommand("old-remote-command", "Old remote command.")],
          })
        : Promise.reject(new Error("commands unavailable"));
    });
    const client = { request } as never;

    const firstRevalidation = revalidateChatMetadata(client, "main");
    const remoteFirst = await loadSlashCommandCatalogResult(client, "main", {
      awaitMetadataRevalidation: true,
      refreshRemote: true,
    });
    expect(remoteFirst.commands.some((command) => command.name === "old-remote-command")).toBe(
      true,
    );

    resolveFirstMetadata?.({
      commands: [remoteCommand("fresh-metadata-command", "Fresh metadata command.")],
    });
    await firstRevalidation;
    const authoritative = await loadSlashCommandCatalogResult(client, "main", {
      awaitMetadataRevalidation: true,
    });
    expect(
      authoritative.commands.some((command) => command.name === "fresh-metadata-command"),
    ).toBe(true);

    const secondRevalidation = revalidateChatMetadata(client, "main");
    const afterFailure = loadSlashCommandCatalogResult(client, "main", {
      awaitMetadataRevalidation: true,
      refreshRemote: true,
    });
    const metadataFailure = expect(secondRevalidation).rejects.toThrow("metadata unavailable");
    rejectSecondMetadata?.(new Error("metadata unavailable"));
    await metadataFailure;
    const loaded = await afterFailure;

    expect(loaded.commands.some((command) => command.name === "old-remote-command")).toBe(false);
    expect(remoteRequestCount).toBe(2);
  });

  it("prefers post-invalidation metadata over an older remote request", async () => {
    let rejectMetadata: ((reason?: unknown) => void) | undefined;
    let resolveRemote: ((value: unknown) => void) | undefined;
    const metadataResult = new Promise((_, reject) => {
      rejectMetadata = reject;
    });
    const remoteResult = new Promise((resolve) => {
      resolveRemote = resolve;
    });
    const request = vi.fn((method: string) =>
      method === "chat.metadata" ? metadataResult : remoteResult,
    );
    const client = { request } as never;
    rememberChatMetadata(client, "main", {
      commands: [remoteCommand("old-metadata-command", "Old metadata command.")],
    });
    const revalidation = revalidateChatMetadata(client, "main");
    const catalog = loadSlashCommandCatalog(client, "main", {
      awaitMetadataRevalidation: true,
      refreshRemote: true,
    });

    const rejection = expect(revalidation).rejects.toThrow("metadata unavailable");
    rejectMetadata?.(new Error("metadata unavailable"));
    await rejection;
    await vi.waitFor(() => {
      expect(request.mock.calls.some(([method]) => method === "commands.list")).toBe(true);
    });
    invalidateChatMetadataStore(client);
    rememberChatMetadata(client, "main", {
      commands: [remoteCommand("post-invalidation-command", "Fresh metadata command.")],
    });
    resolveRemote?.({
      commands: [remoteCommand("old-remote-command", "Old remote command.")],
    });
    const loaded = await catalog;

    expect(loaded.some((command) => command.name === "post-invalidation-command")).toBe(true);
    expect(loaded.some((command) => command.name === "old-remote-command")).toBe(false);
  });

  it("reissues a remote request after metadata-store invalidation", async () => {
    let resolveOldRemote: ((value: unknown) => void) | undefined;
    let resolveFreshRemote: ((value: unknown) => void) | undefined;
    const oldRemote = new Promise((resolve) => {
      resolveOldRemote = resolve;
    });
    const freshRemote = new Promise((resolve) => {
      resolveFreshRemote = resolve;
    });
    const request = vi
      .fn()
      .mockImplementationOnce(() => oldRemote)
      .mockImplementationOnce(() => freshRemote);
    const client = { request } as never;
    const catalog = loadSlashCommandCatalog(client, "main", {
      awaitMetadataRevalidation: true,
      refreshRemote: true,
    });

    await vi.waitFor(() => {
      expect(request).toHaveBeenCalledOnce();
    });
    invalidateChatMetadataStore(client);
    resolveOldRemote?.({
      commands: [remoteCommand("old-remote-command", "Old remote command.")],
    });
    await vi.waitFor(() => {
      expect(request).toHaveBeenCalledTimes(2);
    });
    resolveFreshRemote?.({
      commands: [remoteCommand("fresh-remote-command", "Fresh remote command.")],
    });
    const loaded = await catalog;
    const loadedAgain = await loadSlashCommandCatalog(client, "main");

    expect(loaded.some((command) => command.name === "fresh-remote-command")).toBe(true);
    expect(loaded.some((command) => command.name === "old-remote-command")).toBe(false);
    expect(loadedAgain.some((command) => command.name === "fresh-remote-command")).toBe(true);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("joins a current-generation refresh when an older load observes invalidation", async () => {
    let resolveOldRemote: ((value: unknown) => void) | undefined;
    let resolveFreshRemote: ((value: unknown) => void) | undefined;
    const oldRemote = new Promise((resolve) => {
      resolveOldRemote = resolve;
    });
    const freshRemote = new Promise((resolve) => {
      resolveFreshRemote = resolve;
    });
    const request = vi
      .fn()
      .mockImplementationOnce(() => oldRemote)
      .mockImplementationOnce(() => freshRemote);
    const client = { request } as never;
    const staleGenerationLoad = loadSlashCommandCatalog(client, "main", {
      awaitMetadataRevalidation: true,
      refreshRemote: true,
    });

    await vi.waitFor(() => {
      expect(request).toHaveBeenCalledOnce();
    });
    invalidateChatMetadataStore(client);
    const currentGenerationLoad = loadSlashCommandCatalog(client, "main", {
      awaitMetadataRevalidation: true,
      refreshRemote: true,
    });
    await vi.waitFor(() => {
      expect(request).toHaveBeenCalledTimes(2);
    });

    resolveOldRemote?.({
      commands: [remoteCommand("old-remote-command", "Old remote command.")],
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(request).toHaveBeenCalledTimes(2);

    resolveFreshRemote?.({
      commands: [remoteCommand("fresh-remote-command", "Fresh remote command.")],
    });
    const [loadedFromOldGeneration, loadedFromCurrentGeneration] = await Promise.all([
      staleGenerationLoad,
      currentGenerationLoad,
    ]);
    expect(loadedFromOldGeneration.some((command) => command.name === "fresh-remote-command")).toBe(
      true,
    );
    expect(
      loadedFromCurrentGeneration.some((command) => command.name === "fresh-remote-command"),
    ).toBe(true);
    expect(request).toHaveBeenCalledTimes(2);
  });
});
