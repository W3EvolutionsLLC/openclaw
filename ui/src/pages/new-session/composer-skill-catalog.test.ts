/* @vitest-environment jsdom */

import { render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationContext } from "../../app/context.ts";
import {
  invalidateChatMetadataStore,
  loadChatMetadata,
  rememberChatMetadata,
  revalidateChatMetadata,
} from "../../lib/chat/chat-metadata-store.ts";
import {
  SLASH_COMMANDS,
  buildFallbackSlashCommands,
  replaceSlashCommands,
} from "../../lib/chat/commands.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import { NewSessionAttachmentDraft } from "./attachment-draft.ts";
import { NewSessionComposerTextareaController, renderNewSessionDraftComposer } from "./composer.ts";
import { NewSessionModelControl } from "./model-control.ts";

const attachmentDrafts: NewSessionAttachmentDraft[] = [];
const textareaControllers: NewSessionComposerTextareaController[] = [];

function renderComposer(
  overrides: {
    onInput?: (message: string) => void;
    onSubmit?: () => void;
    textareaController?: NewSessionComposerTextareaController;
    agentId?: string;
    connectionEpoch?: number;
    context?: ApplicationContext;
  } = {},
) {
  const container = document.createElement("div");
  const attachmentDraft = new NewSessionAttachmentDraft(
    () => undefined,
    () => undefined,
  );
  attachmentDrafts.push(attachmentDraft);
  const textareaController =
    overrides.textareaController ?? new NewSessionComposerTextareaController();
  if (!textareaControllers.includes(textareaController)) {
    textareaControllers.push(textareaController);
  }
  let message = "";
  const renderCurrent = () =>
    render(
      renderNewSessionDraftComposer({
        agentId: overrides.agentId ?? "main",
        connectionEpoch: overrides.connectionEpoch ?? 0,
        attachmentDraft,
        canSubmit: true,
        context: overrides.context,
        isCatalogTarget: true,
        message,
        modelControl: new NewSessionModelControl(() => undefined),
        requiresModifier: false,
        requestUpdate: renderCurrent,
        submitting: false,
        textareaController,
        onInput: (next) => {
          message = next;
          overrides.onInput?.(next);
          renderCurrent();
        },
        onSubmit: overrides.onSubmit ?? (() => undefined),
      }),
      container,
    );
  renderCurrent();
  const composer = container.querySelector<HTMLElement>(".new-session-page__composer");
  if (!composer) {
    throw new Error("Expected new-session composer");
  }
  return { composer, container, rerender: renderCurrent, textareaController };
}

function remoteSkill(name: string, description: string) {
  return {
    name,
    textAliases: [`/${name}`],
    description,
    source: "skill" as const,
    scope: "text" as const,
    acceptsArgs: false,
    skillModelVisible: true,
  };
}

afterEach(() => {
  for (const attachmentDraft of attachmentDrafts) {
    attachmentDraft.reset({ release: true });
  }
  attachmentDrafts.length = 0;
  for (const textareaController of textareaControllers) {
    textareaController.disconnect();
  }
  textareaControllers.length = 0;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  replaceSlashCommands(buildFallbackSlashCommands());
});

describe("new-session skill catalog ownership", () => {
  it("opens skill mentions and inserts the selected skill with Enter", async () => {
    const client = { request: vi.fn() } as unknown as GatewayBrowserClient;
    rememberChatMetadata(client, "main", {
      commands: [remoteSkill("release_notes", "Draft release notes.")],
    });
    let message = "";
    const { composer } = renderComposer({
      context: { gateway: { snapshot: { client } } } as unknown as ApplicationContext,
      onInput: (next) => {
        message = next;
      },
    });
    const textarea = composer.querySelector<HTMLTextAreaElement>("textarea");
    if (!textarea) {
      throw new Error("Expected composer textarea");
    }

    textarea.value = "$";
    textarea.setSelectionRange(1, 1);
    textarea.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));

    await waitForFast(() => {
      expect(composer.querySelector(".skill-menu")?.textContent).toContain("release_notes");
    });
    textarea.dispatchEvent(
      new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Enter" }),
    );
    expect(message).toBe("$release_notes ");
  });

  it.each([
    {
      label: "selected agent",
      firstAgentId: "agent-a",
      secondAgentId: "agent-b",
      replaceClient: false,
    },
    {
      label: "Gateway client",
      firstAgentId: "main",
      secondAgentId: "main",
      replaceClient: true,
    },
  ])("keeps delayed skill catalogs scoped when the $label changes", async (testCase) => {
    let resolveAgentA: ((value: unknown) => void) | undefined;
    const agentAResult = new Promise((resolve) => {
      resolveAgentA = resolve;
    });
    const clientA = {
      request: vi.fn().mockReturnValue(agentAResult),
    } as unknown as GatewayBrowserClient;
    const clientB = testCase.replaceClient
      ? ({ request: vi.fn() } as unknown as GatewayBrowserClient)
      : clientA;
    rememberChatMetadata(clientB, testCase.secondAgentId, {
      commands: [remoteSkill("agent_b_skill", "Only for agent B.")],
    });
    const contextFor = (client: GatewayBrowserClient) =>
      ({ gateway: { snapshot: { client } } }) as ApplicationContext;
    replaceSlashCommands([
      {
        key: "active_chat_skill",
        name: "active_chat_skill",
        description: "Owned by active chat.",
        source: "skill",
        skillModelVisible: true,
      },
    ]);
    const textareaController = new NewSessionComposerTextareaController();
    const owner: Parameters<typeof renderComposer>[0] = {
      agentId: testCase.firstAgentId,
      context: contextFor(clientA),
      textareaController,
    };
    const view = renderComposer(owner);
    const firstTextarea = view.composer.querySelector<HTMLTextAreaElement>("textarea");
    if (!firstTextarea) {
      throw new Error("Expected composer textarea");
    }
    firstTextarea.value = "$";
    firstTextarea.setSelectionRange(1, 1);
    firstTextarea.dispatchEvent(
      new InputEvent("input", { bubbles: true, inputType: "insertText" }),
    );

    expect(view.container.querySelector(".skill-menu")?.textContent).not.toContain(
      "active_chat_skill",
    );

    owner.agentId = testCase.secondAgentId;
    owner.context = contextFor(clientB);
    view.rerender();
    await waitForFast(() => {
      expect(view.container.querySelector(".skill-menu")?.textContent).toContain("agent_b_skill");
    });

    resolveAgentA?.({
      commands: [remoteSkill("agent_a_skill", "Only for agent A.")],
    });
    await agentAResult;
    await Promise.resolve();
    await Promise.resolve();
    expect(view.container.querySelector(".skill-menu")?.textContent).toContain("agent_b_skill");
    expect(view.container.querySelector(".skill-menu")?.textContent).not.toContain("agent_a_skill");
    expect(SLASH_COMMANDS.map((command) => command.name)).toEqual(["active_chat_skill"]);
  });

  it("renders metadata skills before a slower remote refresh settles", async () => {
    let resolveMetadata: ((value: unknown) => void) | undefined;
    let resolveRemote: ((value: unknown) => void) | undefined;
    const metadataResult = new Promise((resolve) => {
      resolveMetadata = resolve;
    });
    const remoteResult = new Promise((resolve) => {
      resolveRemote = resolve;
    });
    const client = {
      request: vi.fn((method: string) =>
        method === "chat.metadata" ? metadataResult : remoteResult,
      ),
    } as unknown as GatewayBrowserClient;
    const revalidation = revalidateChatMetadata(client, "main");
    const view = renderComposer({
      context: { gateway: { snapshot: { client } } } as unknown as ApplicationContext,
    });
    const textarea = view.composer.querySelector<HTMLTextAreaElement>("textarea");
    if (!textarea) {
      throw new Error("Expected composer textarea");
    }
    textarea.value = "$";
    textarea.setSelectionRange(1, 1);
    textarea.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));

    resolveMetadata?.({
      commands: [remoteSkill("metadata_skill", "Loaded from metadata.")],
    });
    await revalidation;
    await waitForFast(() => {
      expect(view.container.querySelector('[role="option"]')?.textContent).toContain(
        "metadata_skill",
      );
    });
    expect(view.textareaController.skillMenuState.skillCommandRefreshPending).toBe(false);

    resolveRemote?.({ commands: [remoteSkill("remote_skill", "Loaded remotely.")] });
    await Promise.resolve();
  });

  it("keeps the skill menu loading when remote fallback settles before metadata", async () => {
    let resolveMetadata: ((value: unknown) => void) | undefined;
    const metadataResult = new Promise((resolve) => {
      resolveMetadata = resolve;
    });
    const request = vi.fn((method: string) =>
      method === "chat.metadata"
        ? metadataResult
        : Promise.reject(new Error("commands unavailable")),
    );
    const client = { request } as unknown as GatewayBrowserClient;
    const revalidation = revalidateChatMetadata(client, "main");
    const onSubmit = vi.fn();
    const view = renderComposer({
      context: { gateway: { snapshot: { client } } } as unknown as ApplicationContext,
      onSubmit,
    });
    const textarea = view.composer.querySelector<HTMLTextAreaElement>("textarea");
    if (!textarea) {
      throw new Error("Expected composer textarea");
    }
    textarea.value = "$";
    textarea.setSelectionRange(1, 1);
    textarea.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));

    await waitForFast(() => {
      expect(request).toHaveBeenCalledWith("commands.list", expect.any(Object));
    });
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
    expect(view.textareaController.skillMenuState.skillCommandRefreshPending).toBe(true);
    expect(view.container.querySelector(".skill-menu")).not.toBeNull();
    textarea.dispatchEvent(
      new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Enter" }),
    );
    expect(onSubmit).not.toHaveBeenCalled();

    resolveMetadata?.({
      commands: [remoteSkill("metadata_skill", "Loaded from metadata.")],
    });
    await revalidation;
    await waitForFast(() => {
      expect(view.container.querySelector('[role="option"]')?.textContent).toContain(
        "metadata_skill",
      );
    });
    expect(view.textareaController.skillMenuState.skillCommandRefreshPending).toBe(false);
  });

  it("keeps fallback skills pending while the initial metadata load settles", async () => {
    let resolveMetadata: ((value: unknown) => void) | undefined;
    const metadataResult = new Promise((resolve) => {
      resolveMetadata = resolve;
    });
    const request = vi.fn((method: string) =>
      method === "chat.metadata"
        ? metadataResult
        : Promise.reject(new Error("commands unavailable")),
    );
    const client = { request } as unknown as GatewayBrowserClient;
    const metadataLoad = loadChatMetadata(client, "main");
    const view = renderComposer({
      context: { gateway: { snapshot: { client } } } as unknown as ApplicationContext,
    });
    const textarea = view.composer.querySelector<HTMLTextAreaElement>("textarea");
    if (!textarea) {
      throw new Error("Expected composer textarea");
    }
    textarea.value = "$";
    textarea.setSelectionRange(1, 1);
    textarea.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));

    await waitForFast(() => {
      expect(request).toHaveBeenCalledWith("commands.list", expect.any(Object));
    });
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
    expect(view.textareaController.skillMenuState.skillCommandRefreshPending).toBe(true);

    resolveMetadata?.({
      commands: [remoteSkill("metadata_skill", "Loaded from metadata.")],
    });
    await metadataLoad;
    await waitForFast(() => {
      expect(view.container.querySelector('[role="option"]')?.textContent).toContain(
        "metadata_skill",
      );
    });
    expect(view.textareaController.skillMenuState.skillCommandRefreshPending).toBe(false);
  });

  it("keeps a warm remote cache fenced while metadata revalidation settles", async () => {
    let resolveMetadata: ((value: unknown) => void) | undefined;
    const metadataResult = new Promise((resolve) => {
      resolveMetadata = resolve;
    });
    let remoteRequests = 0;
    const request = vi.fn((method: string) => {
      if (method === "chat.metadata") {
        return metadataResult;
      }
      remoteRequests += 1;
      return remoteRequests === 1
        ? Promise.resolve({ commands: [remoteSkill("warm_skill", "Warm remote skill.")] })
        : Promise.reject(new Error("commands unavailable"));
    });
    const client = { request } as unknown as GatewayBrowserClient;
    const view = renderComposer({
      context: { gateway: { snapshot: { client } } } as unknown as ApplicationContext,
    });
    const textarea = view.composer.querySelector<HTMLTextAreaElement>("textarea");
    if (!textarea) {
      throw new Error("Expected composer textarea");
    }
    textarea.value = "$";
    textarea.setSelectionRange(1, 1);
    textarea.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
    await waitForFast(() => {
      expect(view.container.querySelector(".skill-menu")?.textContent).toContain("warm_skill");
    });

    const revalidation = revalidateChatMetadata(client, "main");
    await waitForFast(() => {
      expect(remoteRequests).toBe(2);
    });
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
    expect(view.textareaController.skillMenuState.skillCommandRefreshPending).toBe(true);
    expect(view.container.querySelector(".skill-menu")?.textContent).not.toContain("warm_skill");

    resolveMetadata?.({
      commands: [remoteSkill("fresh_skill", "Fresh metadata skill.")],
    });
    await revalidation;
    await waitForFast(() => {
      expect(view.container.querySelector('[role="option"]')?.textContent).toContain("fresh_skill");
    });
  });

  it("keeps stale skills unselectable after metadata fails while remote refresh is pending", async () => {
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
    const client = { request } as unknown as GatewayBrowserClient;
    rememberChatMetadata(client, "main", {
      commands: [remoteSkill("old_skill", "Old metadata skill.")],
    });
    const view = renderComposer({
      context: { gateway: { snapshot: { client } } } as unknown as ApplicationContext,
    });
    const textarea = view.composer.querySelector<HTMLTextAreaElement>("textarea");
    if (!textarea) {
      throw new Error("Expected composer textarea");
    }
    textarea.value = "$";
    textarea.setSelectionRange(1, 1);
    textarea.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
    await waitForFast(() => {
      expect(view.container.querySelector(".skill-menu")?.textContent).toContain("old_skill");
    });

    const revalidation = revalidateChatMetadata(client, "main");
    await waitForFast(() => {
      expect(request).toHaveBeenCalledWith("commands.list", expect.any(Object));
      expect(view.textareaController.skillMenuState.skillCommandRefreshPending).toBe(true);
    });
    const rejection = expect(revalidation).rejects.toThrow("metadata unavailable");
    rejectMetadata?.(new Error("metadata unavailable"));
    await rejection;
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
    expect(view.textareaController.skillMenuState.skillCommandRefreshPending).toBe(true);
    expect(view.container.querySelector(".skill-menu")?.textContent).not.toContain("old_skill");

    resolveRemote?.({
      commands: [remoteSkill("fresh_remote_skill", "Fresh remote skill.")],
    });
    await waitForFast(() => {
      expect(view.textareaController.skillMenuState.skillCommandRefreshPending).toBe(false);
      expect(view.container.querySelector(".skill-menu")?.textContent).toContain(
        "fresh_remote_skill",
      );
    });
  });

  it("keeps stale skills fenced when metadata omits commands before remote refresh settles", async () => {
    let resolveMetadata: ((value: unknown) => void) | undefined;
    let resolveRemote: ((value: unknown) => void) | undefined;
    const metadataResult = new Promise((resolve) => {
      resolveMetadata = resolve;
    });
    const remoteResult = new Promise((resolve) => {
      resolveRemote = resolve;
    });
    const request = vi.fn((method: string) =>
      method === "chat.metadata" ? metadataResult : remoteResult,
    );
    const client = { request } as unknown as GatewayBrowserClient;
    rememberChatMetadata(client, "main", {
      commands: [remoteSkill("old_skill", "Old metadata skill.")],
    });
    const view = renderComposer({
      context: { gateway: { snapshot: { client } } } as unknown as ApplicationContext,
    });
    const textarea = view.composer.querySelector<HTMLTextAreaElement>("textarea");
    if (!textarea) {
      throw new Error("Expected composer textarea");
    }
    textarea.value = "$";
    textarea.setSelectionRange(1, 1);
    textarea.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
    await waitForFast(() => {
      expect(view.container.querySelector(".skill-menu")?.textContent).toContain("old_skill");
    });

    const revalidation = revalidateChatMetadata(client, "main");
    await waitForFast(() => {
      expect(request).toHaveBeenCalledWith("commands.list", expect.any(Object));
      expect(view.textareaController.skillMenuState.skillCommandRefreshPending).toBe(true);
    });
    resolveMetadata?.({ models: [], swarmEnabled: false });
    await revalidation;
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
    expect(view.textareaController.skillMenuState.skillCommandRefreshPending).toBe(true);
    expect(view.container.querySelector(".skill-menu")?.textContent).not.toContain("old_skill");

    resolveRemote?.({
      commands: [remoteSkill("fresh_remote_skill", "Fresh remote skill.")],
    });
    await waitForFast(() => {
      expect(view.textareaController.skillMenuState.skillCommandRefreshPending).toBe(false);
      expect(view.container.querySelector(".skill-menu")?.textContent).toContain(
        "fresh_remote_skill",
      );
    });
  });

  it("updates an open skill menu when a later metadata revalidation settles", async () => {
    let resolveMetadata: ((value: unknown) => void) | undefined;
    const metadataResult = new Promise((resolve) => {
      resolveMetadata = resolve;
    });
    const client = {
      request: vi.fn(() => metadataResult),
    } as unknown as GatewayBrowserClient;
    rememberChatMetadata(client, "main", {
      commands: [remoteSkill("old_skill", "Old metadata skill.")],
    });
    const view = renderComposer({
      context: { gateway: { snapshot: { client } } } as unknown as ApplicationContext,
    });
    const textarea = view.composer.querySelector<HTMLTextAreaElement>("textarea");
    if (!textarea) {
      throw new Error("Expected composer textarea");
    }
    textarea.value = "$";
    textarea.setSelectionRange(1, 1);
    textarea.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
    await waitForFast(() => {
      expect(view.container.querySelector(".skill-menu")?.textContent).toContain("old_skill");
    });

    const revalidation = revalidateChatMetadata(client, "main");
    await waitForFast(() => {
      expect(view.textareaController.skillMenuState.skillCommandRefreshPending).toBe(true);
      expect(view.container.querySelector(".skill-menu")?.textContent).not.toContain("old_skill");
    });
    resolveMetadata?.({
      commands: [remoteSkill("fresh_skill", "Fresh metadata skill.")],
    });
    await revalidation;
    await waitForFast(() => {
      expect(view.container.querySelector(".skill-menu")?.textContent).toContain("fresh_skill");
      expect(view.container.querySelector(".skill-menu")?.textContent).not.toContain("old_skill");
    });
  });

  it("rejects an older same-owner refresh after a newer refresh is visible", async () => {
    let resolveFirstRemote: ((value: unknown) => void) | undefined;
    let resolveSecondRemote: ((value: unknown) => void) | undefined;
    let resolveMetadata: ((value: unknown) => void) | undefined;
    const firstRemote = new Promise((resolve) => {
      resolveFirstRemote = resolve;
    });
    const secondRemote = new Promise((resolve) => {
      resolveSecondRemote = resolve;
    });
    const metadata = new Promise((resolve) => {
      resolveMetadata = resolve;
    });
    let remoteRequests = 0;
    const client = {
      request: vi.fn((method: string) => {
        if (method === "chat.metadata") {
          return metadata;
        }
        remoteRequests += 1;
        return remoteRequests === 1 ? firstRemote : secondRemote;
      }),
    } as unknown as GatewayBrowserClient;
    let message = "";
    const view = renderComposer({
      context: { gateway: { snapshot: { client } } } as unknown as ApplicationContext,
      onInput: (next) => {
        message = next;
      },
    });
    const textarea = view.composer.querySelector<HTMLTextAreaElement>("textarea");
    if (!textarea) {
      throw new Error("Expected composer textarea");
    }
    textarea.value = "$";
    textarea.setSelectionRange(1, 1);
    textarea.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
    await waitForFast(() => {
      expect(remoteRequests).toBe(1);
    });

    const revalidation = revalidateChatMetadata(client, "main");
    await waitForFast(() => {
      expect(remoteRequests).toBe(2);
    });
    resolveSecondRemote?.({
      commands: [remoteSkill("fresh_second", "Fresh second request.")],
    });
    await waitForFast(() => {
      expect(view.textareaController.skillMenuState.skillCommandRefreshPending).toBe(true);
      expect(view.container.querySelector(".skill-menu")?.textContent).not.toContain(
        "fresh_second",
      );
    });

    resolveFirstRemote?.({
      commands: [remoteSkill("stale_first", "Stale first request.")],
    });
    await firstRemote;
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
    expect(view.container.querySelector(".skill-menu")?.textContent).not.toContain("stale_first");

    resolveMetadata?.({
      commands: [remoteSkill("fresh_second", "Fresh metadata result.")],
    });
    await revalidation;
    await waitForFast(() => {
      expect(view.container.querySelector(".skill-menu")?.textContent).toContain("fresh_second");
    });
    textarea.dispatchEvent(
      new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Enter" }),
    );
    expect(message).toBe("$fresh_second ");
  });

  it.each([
    { metadataFirst: false, label: "after commands.list" },
    { metadataFirst: true, label: "before commands.list" },
  ])("publishes metadata that settles $label", async ({ metadataFirst }) => {
    let resolveMetadata: ((value: unknown) => void) | undefined;
    let resolveRemote: ((value: unknown) => void) | undefined;
    const metadataResult = new Promise((resolve) => {
      resolveMetadata = resolve;
    });
    const remoteResult = new Promise((resolve) => {
      resolveRemote = resolve;
    });
    const client = {
      request: vi.fn((method: string) =>
        method === "chat.metadata" ? metadataResult : remoteResult,
      ),
    } as unknown as GatewayBrowserClient;
    const revalidation = revalidateChatMetadata(client, "main");
    const textareaController = new NewSessionComposerTextareaController();
    textareaControllers.push(textareaController);
    const onCatalogChange = vi.fn();
    let refreshSettled = false;
    const refresh = textareaController
      .refreshCommandCatalog(client, "main", 0, onCatalogChange)
      .finally(() => {
        refreshSettled = true;
      });

    if (metadataFirst) {
      resolveMetadata?.({
        commands: [remoteSkill("metadata_skill", "Loaded from metadata.")],
      });
      await revalidation;
      await waitForFast(() => {
        expect(textareaController.getCommandCatalog().map((command) => command.name)).toContain(
          "metadata_skill",
        );
      });
      expect(refreshSettled).toBe(false);
      resolveRemote?.({ commands: [remoteSkill("remote_skill", "Loaded remotely.")] });
    } else {
      resolveRemote?.({ commands: [remoteSkill("remote_skill", "Loaded remotely.")] });
      await Promise.resolve();
      expect(refreshSettled).toBe(false);
      resolveMetadata?.({
        commands: [remoteSkill("metadata_skill", "Loaded from metadata.")],
      });
      await revalidation;
    }

    await refresh;
    await waitForFast(() => {
      const names = textareaController.getCommandCatalog().map((command) => command.name);
      expect(names).toContain("metadata_skill");
      expect(names).not.toContain("remote_skill");
    });
    expect(onCatalogChange).toHaveBeenCalled();
  });

  it("rejects a delayed catalog after returning to the same command owner", async () => {
    let resolveStaleAgentA: ((value: unknown) => void) | undefined;
    const staleAgentAResult = new Promise((resolve) => {
      resolveStaleAgentA = resolve;
    });
    const client = {
      request: vi
        .fn()
        .mockReturnValueOnce(staleAgentAResult)
        .mockResolvedValueOnce({
          commands: [remoteSkill("fresh_agent_a_skill", "Fresh agent A skill.")],
        }),
    } as unknown as GatewayBrowserClient;
    const context = { gateway: { snapshot: { client } } } as ApplicationContext;
    const textareaController = new NewSessionComposerTextareaController();
    const owner: Parameters<typeof renderComposer>[0] = {
      agentId: "agent-a",
      context,
      textareaController,
    };
    const view = renderComposer(owner);
    const firstTextarea = view.composer.querySelector<HTMLTextAreaElement>("textarea");
    if (!firstTextarea) {
      throw new Error("Expected composer textarea");
    }
    firstTextarea.value = "$";
    firstTextarea.setSelectionRange(1, 1);
    firstTextarea.dispatchEvent(
      new InputEvent("input", { bubbles: true, inputType: "insertText" }),
    );

    owner.agentId = "agent-b";
    view.rerender();
    owner.agentId = "agent-a";
    view.rerender();
    await waitForFast(() => {
      expect(view.container.querySelector(".skill-menu")?.textContent).toContain(
        "fresh_agent_a_skill",
      );
    });

    resolveStaleAgentA?.({
      commands: [remoteSkill("stale_agent_a_skill", "Stale agent A skill.")],
    });
    await staleAgentAResult;
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
    await textareaController.refreshCommandCatalog(client, "agent-a", 0);
    const catalogNames = textareaController.getCommandCatalog().map((command) => command.name);
    expect(catalogNames).toContain("fresh_agent_a_skill");
    expect(catalogNames).not.toContain("stale_agent_a_skill");
    expect(view.container.querySelector(".skill-menu")?.textContent).toContain(
      "fresh_agent_a_skill",
    );
    expect(view.container.querySelector(".skill-menu")?.textContent).not.toContain(
      "stale_agent_a_skill",
    );
  });

  it("resets skill completion ownership when the Gateway connection epoch changes", async () => {
    const client = {
      request: vi.fn().mockResolvedValue({
        commands: [remoteSkill("new_connection_skill", "New connection skill.")],
      }),
    } as unknown as GatewayBrowserClient;
    rememberChatMetadata(client, "main", {
      commands: [remoteSkill("old_connection_skill", "Old connection skill.")],
    });
    const owner: Parameters<typeof renderComposer>[0] = {
      agentId: "main",
      connectionEpoch: 1,
      context: { gateway: { snapshot: { client } } } as unknown as ApplicationContext,
    };
    const view = renderComposer(owner);
    const textarea = view.composer.querySelector<HTMLTextAreaElement>("textarea");
    if (!textarea) {
      throw new Error("Expected composer textarea");
    }
    textarea.value = "$";
    textarea.setSelectionRange(1, 1);
    textarea.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
    await waitForFast(() => {
      expect(view.container.querySelector(".skill-menu")?.textContent).toContain(
        "old_connection_skill",
      );
    });

    owner.connectionEpoch = 2;
    view.rerender();
    expect(view.container.querySelector(".skill-menu")?.textContent ?? "").not.toContain(
      "old_connection_skill",
    );

    await waitForFast(() => {
      expect(view.container.querySelector(".skill-menu")?.textContent).toContain(
        "new_connection_skill",
      );
    });
  });

  it("resets skill completion ownership when metadata storage is invalidated", async () => {
    const client = { request: vi.fn() } as unknown as GatewayBrowserClient;
    rememberChatMetadata(client, "main", {
      commands: [remoteSkill("old_skill", "Old metadata skill.")],
    });
    const owner: Parameters<typeof renderComposer>[0] = {
      agentId: "main",
      connectionEpoch: 1,
      context: { gateway: { snapshot: { client } } } as unknown as ApplicationContext,
    };
    const view = renderComposer(owner);
    const textarea = view.composer.querySelector<HTMLTextAreaElement>("textarea");
    if (!textarea) {
      throw new Error("Expected composer textarea");
    }
    textarea.value = "$";
    textarea.setSelectionRange(1, 1);
    textarea.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
    await waitForFast(() => {
      expect(view.container.querySelector(".skill-menu")?.textContent).toContain("old_skill");
    });

    invalidateChatMetadataStore(client);
    await waitForFast(() => {
      expect(view.container.querySelector(".skill-menu")?.textContent ?? "").not.toContain(
        "old_skill",
      );
    });
    rememberChatMetadata(client, "main", {
      commands: [remoteSkill("new_skill", "New metadata skill.")],
    });
    await waitForFast(() => {
      expect(view.container.querySelector(".skill-menu")?.textContent).toContain("new_skill");
    });
  });

  it("preserves active skill reconciliation across invalidation and reconnect", async () => {
    let resolveMetadata: ((value: unknown) => void) | undefined;
    const metadataResult = new Promise((resolve) => {
      resolveMetadata = resolve;
    });
    const client = {
      request: vi.fn((method: string) =>
        method === "chat.metadata"
          ? metadataResult
          : Promise.resolve({
              commands: [remoteSkill("new_connection_skill", "New connection skill.")],
            }),
      ),
    } as unknown as GatewayBrowserClient;
    rememberChatMetadata(client, "main", {
      commands: [remoteSkill("old_connection_skill", "Old connection skill.")],
    });
    const owner: Parameters<typeof renderComposer>[0] = {
      agentId: "main",
      connectionEpoch: 1,
      context: { gateway: { snapshot: { client } } } as unknown as ApplicationContext,
    };
    const view = renderComposer(owner);
    const textarea = view.composer.querySelector<HTMLTextAreaElement>("textarea");
    if (!textarea) {
      throw new Error("Expected composer textarea");
    }
    textarea.value = "$";
    textarea.setSelectionRange(1, 1);
    textarea.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
    await waitForFast(() => {
      expect(view.container.querySelector(".skill-menu")?.textContent).toContain(
        "old_connection_skill",
      );
    });

    const revalidation = revalidateChatMetadata(client, "main");
    invalidateChatMetadataStore(client);
    owner.connectionEpoch = 2;
    view.rerender();

    await waitForFast(() => {
      expect(view.container.querySelector(".skill-menu")?.textContent).toContain(
        "new_connection_skill",
      );
    });
    expect(view.container.querySelector(".skill-menu")?.textContent).not.toContain(
      "old_connection_skill",
    );
    resolveMetadata?.({ commands: [] });
    await revalidation;
  });

  it("reconciles an open skill menu after shared metadata revalidation", async () => {
    let resolveFreshMetadata: ((value: unknown) => void) | undefined;
    const freshMetadataResult = new Promise((resolve) => {
      resolveFreshMetadata = resolve;
    });
    const client = {
      request: vi.fn().mockReturnValue(freshMetadataResult),
    } as unknown as GatewayBrowserClient;
    rememberChatMetadata(client, "main", {
      commands: [remoteSkill("old_skill", "Old cached skill.")],
    });
    const revalidation = revalidateChatMetadata(client, "main");
    const view = renderComposer({
      agentId: "main",
      connectionEpoch: 1,
      context: { gateway: { snapshot: { client } } } as unknown as ApplicationContext,
    });
    const textarea = view.composer.querySelector<HTMLTextAreaElement>("textarea");
    if (!textarea) {
      throw new Error("Expected composer textarea");
    }
    textarea.value = "$";
    textarea.setSelectionRange(1, 1);
    textarea.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));

    resolveFreshMetadata?.({
      commands: [remoteSkill("fresh_skill", "Fresh revalidated skill.")],
    });
    await revalidation;
    await waitForFast(() => {
      expect(view.container.querySelector(".skill-menu")?.textContent).toContain("fresh_skill");
    });
    expect(view.container.querySelector(".skill-menu")?.textContent).not.toContain("old_skill");
  });
});
