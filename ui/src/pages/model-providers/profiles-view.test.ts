/* @vitest-environment jsdom */

import { nothing, render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../../i18n/index.ts";
import type { ModelProviderCard } from "./data.ts";
import { renderModelProviders } from "./view.ts";

type ModelProvidersViewProps = Parameters<typeof renderModelProviders>[0];

function card(overrides: Partial<ModelProviderCard> = {}): ModelProviderCard {
  return {
    id: "openai",
    displayName: "OpenAI",
    profiles: [],
    profileProviderIds: {},
    profileAuthProviderIds: {},
    profileOwnerProfileIds: {},
    profileOrder: [],
    profileOrders: {},
    profileOrderProviders: {},
    credentialProviderIds: ["openai"],
    hasConfigApiKey: false,
    modelCount: 1,
    availableModelCount: 1,
    apiKey: { source: "env", envVar: "OPENAI_API_KEY" },
    ...overrides,
  };
}

function props(overrides: Partial<ModelProvidersViewProps> = {}): ModelProvidersViewProps {
  return {
    connected: true,
    loading: false,
    refreshing: false,
    error: null,
    updatedAt: 1,
    costDays: 30,
    cards: [card()],
    configuredModels: [{ id: "openai/gpt-5", provider: "openai", name: "GPT-5", available: true }],
    defaultModels: { primary: "openai/gpt-5", fallbacks: [], utilityModel: null },
    defaultModelsDirty: false,
    thinkingLevel: "off",
    thinkingOverridden: true,
    fastMode: false,
    fastModeOverridden: true,
    configBusy: false,
    unconfiguredProviders: [{ id: "anthropic", displayName: "Anthropic" }],
    canMutate: true,
    mutationBlockedReason: null,
    probeAvailable: true,
    profileOrderAvailable: true,
    profileCooldownClearAvailable: true,
    profileCanMutate: true,
    busy: {},
    messages: {},
    probeResults: {},
    keyEditorProvider: null,
    keyDraft: "",
    addProviderOpen: false,
    addProviderId: "",
    addProviderKey: "",
    onRefresh: () => undefined,
    onOpenKeyEditor: () => undefined,
    onCloseKeyEditor: () => undefined,
    onKeyDraftChange: () => undefined,
    onSaveKey: () => undefined,
    onRemoveKey: () => undefined,
    onProbe: () => undefined,
    onLogoutProfile: () => undefined,
    onProfileOrderChange: () => undefined,
    onClearProfileCooldown: () => undefined,
    onAddProviderToggle: () => undefined,
    onAddProviderIdChange: () => undefined,
    onAddProviderKeyChange: () => undefined,
    onAddProvider: () => undefined,
    onPrimaryChange: () => undefined,
    onFallbackAdd: () => undefined,
    onFallbackRemove: () => undefined,
    onUtilityChange: () => undefined,
    onDefaultModelsSave: () => undefined,
    onDefaultModelsReset: () => undefined,
    onThinkingChange: () => undefined,
    onThinkingReset: () => undefined,
    onFastModeChange: () => undefined,
    onFastModeReset: () => undefined,
    onOpenModelSetup: () => undefined,
    ...overrides,
  };
}

function mount(viewProps: ModelProvidersViewProps): HTMLDivElement {
  const container = document.createElement("div");
  document.body.append(container);
  render(renderModelProviders(viewProps), container);
  return container;
}

function text(element: Element | null): string {
  return element?.textContent?.replace(/\s+/gu, " ").trim() ?? "";
}

function button(container: Element, label: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll<HTMLButtonElement>("button")].find((entry) =>
    text(entry).includes(label),
  );
}

function dragDataTransfer(): DataTransfer {
  const values = new Map<string, string>();
  return {
    dropEffect: "none",
    effectAllowed: "uninitialized",
    files: [] as unknown as FileList,
    getData: (type: string) => values.get(type) ?? "",
    items: [] as unknown as DataTransferItemList,
    setData(type: string, value: string) {
      values.set(type, value);
    },
    clearData(type?: string) {
      if (type) {
        values.delete(type);
      } else {
        values.clear();
      }
    },
    setDragImage: vi.fn(),
    get types() {
      return [...values.keys()];
    },
  };
}

function dragEvent(type: string, dataTransfer: DataTransfer, clientY = 0): DragEvent {
  const event = new Event(type, { bubbles: true, cancelable: true }) as DragEvent;
  Object.defineProperties(event, {
    clientY: { value: clientY },
    dataTransfer: { value: dataTransfer },
  });
  return event;
}

function pointerEvent(type: string, clientY = 0): PointerEvent {
  const event = new Event(type, { bubbles: true, cancelable: true }) as PointerEvent;
  Object.defineProperties(event, {
    button: { value: 0 },
    clientX: { value: 20 },
    clientY: { value: clientY },
    pointerId: { value: 7 },
    pointerType: { value: "touch" },
  });
  return event;
}

describe("renderModelProviders", () => {
  beforeEach(async () => {
    await i18n.setLocale("en");
  });

  afterEach(() => {
    for (const container of document.body.querySelectorAll("div")) {
      render(nothing, container);
    }
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  it("renders an aligned profile roster and emits drag and availability actions", () => {
    const now = 1_700_000_000_000;
    vi.spyOn(Date, "now").mockReturnValue(now);
    const onProfileOrderChange = vi.fn();
    const onClearProfileCooldown = vi.fn();
    const container = mount(
      props({
        cards: [
          card({
            profiles: [
              {
                profileId: "openai:primary",
                type: "oauth",
                status: "ok",
                displayName: "Primary",
                lastUsedAt: now - 2 * 60 * 60_000,
              },
              {
                profileId: "openai:backup",
                type: "oauth",
                status: "ok",
                email: "backup@example.com",
                cooldownUntil: now + 12 * 60_000,
                cooldownReason: "rate_limit",
              },
              {
                profileId: "openai:key",
                type: "api_key",
                status: "static",
              },
              {
                profileId: "openai-codex:work",
                type: "oauth",
                status: "ok",
                displayName: "Work",
              },
            ],
            profileProviderIds: {
              "openai:primary": "openai",
              "openai:backup": "openai",
              "openai:key": "openai",
              "openai-codex:work": "openai-codex",
            },
            profileAuthProviderIds: {
              "openai:primary": "openai",
              "openai:backup": "openai",
              "openai:key": "openai",
              "openai-codex:work": "openai-codex",
            },
            profileOrder: ["openai:primary", "openai:key", "openai:backup", "openai-codex:work"],
            profileOrders: {
              openai: ["openai:primary", "openai:key", "openai:backup"],
              "openai-codex": ["openai-codex:work"],
            },
          }),
        ],
        onProfileOrderChange,
        onClearProfileCooldown,
      }),
    );

    const roster = container.querySelector<HTMLElement>("section.model-providers__profiles");
    expect(roster).not.toBeNull();
    expect(container.querySelector("details.model-providers__profiles")).toBeNull();
    expect(text(roster)).toContain("4 accounts · drag to set priority");
    expect(text(roster)).toContain("backup@example.com");
    expect(text(roster)).toContain("Last used 2h ago");
    expect(text(roster)).toContain("Available again in 12m");
    expect(text(roster)).not.toContain("cooldown");
    expect(text(container.querySelector(".model-providers__credential-source"))).toBe(
      "API key from OPENAI_API_KEY",
    );
    expect(container.querySelector(".model-providers__profile-order")).toBeNull();

    const primaryRow = container.querySelector<HTMLElement>('[data-profile-id="openai:primary"]');
    const backupRow = container.querySelector<HTMLElement>('[data-profile-id="openai:backup"]');
    const backupGrip = backupRow?.querySelector<HTMLButtonElement>(
      ".model-providers__profile-grip",
    );
    expect(backupGrip?.draggable).toBe(true);
    expect(backupGrip?.getAttribute("aria-keyshortcuts")).toBe("ArrowUp ArrowDown");
    const transfer = dragDataTransfer();
    if (primaryRow) {
      primaryRow.getBoundingClientRect = () =>
        ({
          bottom: 52,
          height: 52,
          left: 0,
          right: 320,
          top: 0,
          width: 320,
          x: 0,
          y: 0,
        }) as DOMRect;
    }
    backupGrip?.dispatchEvent(dragEvent("dragstart", transfer));
    primaryRow?.dispatchEvent(dragEvent("dragover", transfer, 1));
    expect(primaryRow?.classList.contains("model-providers__profile--drop-before")).toBe(true);
    primaryRow?.dispatchEvent(dragEvent("drop", transfer, 1));
    expect(onProfileOrderChange).toHaveBeenCalledWith("openai", [
      "openai:backup",
      "openai:primary",
      "openai:key",
    ]);

    onProfileOrderChange.mockClear();
    const elementFromPoint = Object.getOwnPropertyDescriptor(document, "elementFromPoint");
    Object.defineProperty(document, "elementFromPoint", {
      configurable: true,
      value: vi.fn(() => primaryRow),
    });
    if (backupGrip) {
      backupGrip.setPointerCapture = vi.fn();
      backupGrip.releasePointerCapture = vi.fn();
    }
    try {
      backupGrip?.dispatchEvent(pointerEvent("pointerdown", 40));
      backupGrip?.dispatchEvent(pointerEvent("pointermove", 1));
      expect(primaryRow?.classList.contains("model-providers__profile--drop-before")).toBe(true);
      backupGrip?.dispatchEvent(pointerEvent("pointerup", 1));
      expect(onProfileOrderChange).toHaveBeenCalledWith("openai", [
        "openai:backup",
        "openai:primary",
        "openai:key",
      ]);

      onProfileOrderChange.mockClear();
      backupGrip?.dispatchEvent(pointerEvent("pointerdown", 40));
      backupGrip?.dispatchEvent(pointerEvent("pointermove", 1));
      backupGrip?.dispatchEvent(pointerEvent("pointercancel", 1));
      expect(onProfileOrderChange).not.toHaveBeenCalled();
      expect(container.querySelector(".model-providers__profile--dragging")).toBeNull();
      expect(primaryRow?.classList.contains("model-providers__profile--drop-before")).toBe(false);

      backupGrip?.dispatchEvent(pointerEvent("pointerdown", 40));
      backupGrip?.dispatchEvent(pointerEvent("pointermove", 1));
      backupGrip?.dispatchEvent(pointerEvent("pointerup", 1));
    } finally {
      if (elementFromPoint) {
        Object.defineProperty(document, "elementFromPoint", elementFromPoint);
      } else {
        Reflect.deleteProperty(document, "elementFromPoint");
      }
    }
    expect(onProfileOrderChange).toHaveBeenCalledWith("openai", [
      "openai:backup",
      "openai:primary",
      "openai:key",
    ]);

    const retry = backupRow?.querySelector<HTMLButtonElement>(
      'button[aria-label="Try backup@example.com again now"]',
    );
    expect(retry?.parentElement).toBe(backupRow?.querySelector(".model-providers__profile-status"));
    retry?.click();
    expect(retry?.getAttribute("aria-label")).toBe("Try backup@example.com again now");
    expect(onClearProfileCooldown).toHaveBeenCalledWith("openai", "openai", "openai:backup");
  });

  it("presents profiles without an explicit order as automatic rotation", () => {
    const onProfileOrderChange = vi.fn();
    const container = mount(
      props({
        cards: [
          card({
            profiles: [
              { profileId: "openai:two", type: "oauth", status: "ok" },
              { profileId: "openai:one", type: "oauth", status: "ok" },
            ],
            profileProviderIds: {
              "openai:one": "openai",
              "openai:two": "openai",
            },
            profileAuthProviderIds: {
              "openai:one": "openai",
              "openai:two": "openai",
            },
          }),
        ],
        onProfileOrderChange,
      }),
    );

    const roster = container.querySelector<HTMLElement>("section.model-providers__profiles");
    expect(text(roster)).toContain("2 accounts · drag to set priority");
    expect(container.querySelector(".model-providers__profile-order")).toBeNull();
    expect(
      [...container.querySelectorAll<HTMLButtonElement>(".model-providers__profile-grip")].every(
        (grip) => !grip.disabled,
      ),
    ).toBe(true);
    expect(
      [...container.querySelectorAll<HTMLElement>(".model-providers__profile")].map(
        (row) => row.dataset.profileId,
      ),
    ).toEqual(["openai:two", "openai:one"]);
    container
      .querySelector<HTMLButtonElement>(
        '[data-profile-id="openai:two"] .model-providers__profile-grip',
      )
      ?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    expect(onProfileOrderChange).toHaveBeenCalledWith("openai", ["openai:one", "openai:two"]);
  });

  it("labels an included immovable account with its saved priority", () => {
    const container = mount(
      props({
        cards: [
          card({
            profiles: [{ profileId: "openai:only", type: "oauth", status: "ok" }],
            profileProviderIds: { "openai:only": "openai" },
            profileAuthProviderIds: { "openai:only": "openai" },
            profileOwnerProfileIds: { openai: ["openai:only"] },
            profileOrder: ["openai:only"],
            profileOrders: { openai: ["openai:only"] },
          }),
        ],
      }),
    );

    expect(
      container
        .querySelector<HTMLButtonElement>(".model-providers__profile-grip")
        ?.getAttribute("aria-label"),
    ).toBe("openai:only is primary");
  });

  it("does not promise drag reordering when only one saved account can move", () => {
    const container = mount(
      props({
        cards: [
          card({
            profiles: [
              { profileId: "openai:primary", type: "oauth", status: "ok" },
              { profileId: "openai:excluded", type: "oauth", status: "ok" },
            ],
            profileProviderIds: {
              "openai:primary": "openai",
              "openai:excluded": "openai",
            },
            profileAuthProviderIds: {
              "openai:primary": "openai",
              "openai:excluded": "openai",
            },
            profileOwnerProfileIds: {
              openai: ["openai:primary", "openai:excluded"],
            },
            profileOrder: ["openai:primary"],
            profileOrders: { openai: ["openai:primary"] },
          }),
        ],
      }),
    );

    expect(text(container.querySelector(".model-providers__profiles-heading"))).toContain(
      "tried in priority order",
    );
    expect(text(container.querySelector(".model-providers__profiles-heading"))).not.toContain(
      "drag to set priority",
    );
  });

  it("keeps a different auth owner's profile actions enabled while one owner is busy", () => {
    const container = mount(
      props({
        busy: { "logout:openai": true },
        cards: [
          card({
            profiles: [
              {
                profileId: "openai:one",
                type: "oauth",
                status: "ok",
                logoutSupported: true,
              },
              {
                profileId: "anthropic:one",
                type: "oauth",
                status: "ok",
                logoutSupported: true,
              },
            ],
            profileProviderIds: {
              "openai:one": "openai",
              "anthropic:one": "anthropic",
            },
            profileAuthProviderIds: {
              "openai:one": "openai",
              "anthropic:one": "anthropic",
            },
            profileOwnerProfileIds: {
              openai: ["openai:one"],
              anthropic: ["anthropic:one"],
            },
          }),
        ],
      }),
    );

    expect(
      container.querySelector<HTMLButtonElement>(
        '[data-profile-id="openai:one"] .model-providers__profile-logout',
      )?.disabled,
    ).toBe(true);
    expect(
      container.querySelector<HTMLButtonElement>(
        '[data-profile-id="anthropic:one"] .model-providers__profile-logout',
      )?.disabled,
    ).toBe(false);
  });

  it("keeps profile actions enabled when only configuration editing is unavailable", () => {
    const container = mount(
      props({
        canMutate: false,
        mutationBlockedReason: "Configuration unavailable",
        cards: [
          card({
            profiles: [
              {
                profileId: "openai:primary",
                type: "oauth",
                status: "ok",
                logoutSupported: true,
              },
            ],
            profileProviderIds: { "openai:primary": "openai" },
            profileAuthProviderIds: { "openai:primary": "openai" },
            profileOwnerProfileIds: { openai: ["openai:primary"] },
          }),
        ],
      }),
    );

    expect(
      container.querySelector<HTMLButtonElement>(".model-providers__profile-logout")?.disabled,
    ).toBe(false);
  });

  it("hides profile mutations that an older gateway does not advertise", () => {
    const container = mount(
      props({
        profileOrderAvailable: false,
        profileCooldownClearAvailable: false,
        cards: [
          card({
            profiles: [
              {
                profileId: "openai:primary",
                type: "oauth",
                status: "ok",
                logoutSupported: true,
              },
              {
                profileId: "openai:backup",
                type: "oauth",
                status: "ok",
                cooldownUntil: Date.now() + 60_000,
                logoutSupported: true,
              },
            ],
            profileProviderIds: {
              "openai:primary": "openai",
              "openai:backup": "openai",
            },
            profileOrder: ["openai:primary", "openai:backup"],
            profileOrders: { openai: ["openai:primary"] },
          }),
        ],
      }),
    );

    const backup = container.querySelector('[data-profile-id="openai:backup"]')!;
    expect(backup.querySelector('button[aria-label="Log out openai:backup"]')).not.toBeNull();
    expect(backup.querySelector('button[aria-label^="Try "]')).toBeNull();
    expect(button(backup, "Include")).toBeUndefined();
    expect(backup.querySelector("wa-dropdown")).toBeNull();
  });

  it("hides priority mutations when an older gateway omits canonical order ownership", () => {
    const onProfileOrderChange = vi.fn();
    const container = mount(
      props({
        cards: [
          card({
            profiles: [
              { profileId: "openai:primary", type: "oauth", status: "ok" },
              { profileId: "openai:backup", type: "oauth", status: "ok" },
            ],
            profileProviderIds: {
              "openai:primary": "openai",
              "openai:backup": "openai",
            },
            profileOwnerProfileIds: {
              openai: ["openai:primary", "openai:backup"],
            },
          }),
        ],
        onProfileOrderChange,
      }),
    );

    expect(text(container.querySelector("section.model-providers__profiles"))).toContain(
      "2 accounts · automatic rotation",
    );
    expect(
      [...container.querySelectorAll<HTMLButtonElement>(".model-providers__profile-grip")].every(
        (grip) => grip.disabled,
      ),
    ).toBe(true);
    expect(button(container, "Include")).toBeUndefined();
    expect(onProfileOrderChange).not.toHaveBeenCalled();
  });

  it("keeps profiles omitted from an explicit order out of reorder payloads", () => {
    const onProfileOrderChange = vi.fn();
    const container = mount(
      props({
        cards: [
          card({
            profiles: [
              { profileId: "openai:primary", type: "oauth", status: "ok" },
              { profileId: "openai:backup", type: "oauth", status: "ok" },
              { profileId: "openai:excluded", type: "oauth", status: "ok" },
            ],
            profileProviderIds: {
              "openai:primary": "openai",
              "openai:backup": "openai",
              "openai:excluded": "openai",
            },
            profileAuthProviderIds: {
              "openai:primary": "openai",
              "openai:backup": "openai",
              "openai:excluded": "openai",
            },
            profileOrder: ["openai:primary", "openai:backup"],
            profileOrders: { openai: ["openai:primary", "openai:backup"] },
          }),
        ],
        onProfileOrderChange,
      }),
    );

    const excluded = container.querySelector<HTMLElement>('[data-profile-id="openai:excluded"]');
    expect(excluded?.querySelector(".model-providers__profile-order")).toBeNull();
    expect(
      excluded?.querySelector<HTMLButtonElement>(".model-providers__profile-grip")?.disabled,
    ).toBe(true);
    expect(
      excluded
        ?.querySelector<HTMLButtonElement>(".model-providers__profile-grip")
        ?.getAttribute("aria-label"),
    ).toBe("openai:excluded is not in rotation");

    button(excluded!, "Include")?.click();
    expect(button(excluded!, "Include")?.getAttribute("aria-label")).toBe(
      "Include openai:excluded in rotation",
    );
    expect(onProfileOrderChange).toHaveBeenCalledWith("openai", [
      "openai:primary",
      "openai:backup",
      "openai:excluded",
    ]);
    onProfileOrderChange.mockClear();

    container
      .querySelector<HTMLButtonElement>(
        '[data-profile-id="openai:backup"] .model-providers__profile-grip',
      )
      ?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
    expect(onProfileOrderChange).toHaveBeenCalledWith("openai", [
      "openai:backup",
      "openai:primary",
    ]);

    excluded
      ?.querySelector<HTMLButtonElement>(".model-providers__profile-grip")
      ?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
    expect(onProfileOrderChange).toHaveBeenCalledTimes(1);
  });

  it("reorders every profile in a shared alias auth order", () => {
    const onProfileOrderChange = vi.fn();
    const sharedOrder = ["anthropic:one", "claude-cli:two"];
    const container = mount(
      props({
        cards: [
          card({
            id: "anthropic",
            profiles: [
              { profileId: "anthropic:one", type: "oauth", status: "ok" },
              { profileId: "claude-cli:two", type: "token", status: "ok" },
            ],
            profileProviderIds: {
              "anthropic:one": "anthropic",
              "claude-cli:two": "claude-cli",
            },
            profileAuthProviderIds: {
              "anthropic:one": "anthropic",
              "claude-cli:two": "anthropic",
            },
            profileOrder: sharedOrder,
            profileOrders: {
              anthropic: sharedOrder,
            },
            profileOrderProviders: { anthropic: "claude-cli" },
          }),
        ],
        onProfileOrderChange,
      }),
    );

    container
      .querySelector<HTMLButtonElement>(
        '[data-profile-id="claude-cli:two"] .model-providers__profile-grip',
      )
      ?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
    expect(onProfileOrderChange).toHaveBeenCalledWith("claude-cli", [
      "claude-cli:two",
      "anthropic:one",
    ]);
  });

  it("preserves owner-order profiles rendered on another card", () => {
    const onProfileOrderChange = vi.fn();
    const container = mount(
      props({
        cards: [
          card({
            id: "plugin-alias",
            profiles: [
              { profileId: "shared:alias-one", type: "oauth", status: "ok" },
              { profileId: "shared:alias-two", type: "oauth", status: "ok" },
            ],
            profileProviderIds: {
              "shared:alias-one": "plugin-alias",
              "shared:alias-two": "plugin-alias",
            },
            profileAuthProviderIds: {
              "shared:alias-one": "shared-owner",
              "shared:alias-two": "shared-owner",
            },
            profileOrder: ["shared:owner", "shared:alias-one", "shared:alias-two"],
            profileOrders: {
              "shared-owner": ["shared:owner", "shared:alias-one", "shared:alias-two"],
            },
          }),
        ],
        onProfileOrderChange,
      }),
    );

    container
      .querySelector<HTMLButtonElement>(
        '[data-profile-id="shared:alias-two"] .model-providers__profile-grip',
      )
      ?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
    expect(onProfileOrderChange).toHaveBeenCalledWith("shared-owner", [
      "shared:owner",
      "shared:alias-two",
      "shared:alias-one",
    ]);
  });

  it("reorders one auth owner's profiles across usage cards", () => {
    const onProfileOrderChange = vi.fn();
    const sharedOrder = ["anthropic:one", "claude-cli:two"];
    const container = mount(
      props({
        cards: [
          card({
            id: "anthropic",
            profiles: [{ profileId: "anthropic:one", type: "oauth", status: "ok" }],
            profileProviderIds: { "anthropic:one": "anthropic" },
            profileAuthProviderIds: { "anthropic:one": "anthropic" },
            profileOwnerProfileIds: { anthropic: sharedOrder },
            profileOrder: sharedOrder,
            profileOrders: { anthropic: sharedOrder },
          }),
          card({
            id: "claude-cli",
            profiles: [{ profileId: "claude-cli:two", type: "token", status: "ok" }],
            profileProviderIds: { "claude-cli:two": "claude-cli" },
            profileAuthProviderIds: { "claude-cli:two": "anthropic" },
            profileOwnerProfileIds: { anthropic: sharedOrder },
            profileOrder: sharedOrder,
            profileOrders: { anthropic: sharedOrder },
          }),
        ],
        onProfileOrderChange,
      }),
    );

    const sourceGrip = container.querySelector<HTMLButtonElement>(
      '[data-profile-id="claude-cli:two"] .model-providers__profile-grip',
    );
    expect(sourceGrip?.disabled).toBe(false);
    sourceGrip?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
    expect(onProfileOrderChange).toHaveBeenCalledWith("anthropic", [
      "claude-cli:two",
      "anthropic:one",
    ]);

    onProfileOrderChange.mockClear();
    const target = container.querySelector<HTMLElement>('[data-profile-id="anthropic:one"]');
    const transfer = dragDataTransfer();
    if (target) {
      target.getBoundingClientRect = () => ({ height: 52, top: 0, width: 320 }) as DOMRect;
    }
    sourceGrip?.dispatchEvent(dragEvent("dragstart", transfer));
    target?.dispatchEvent(dragEvent("dragover", transfer, 1));
    target?.dispatchEvent(dragEvent("drop", transfer, 1));
    expect(onProfileOrderChange).toHaveBeenCalledWith("anthropic", [
      "claude-cli:two",
      "anthropic:one",
    ]);
  });

  it("lets an operator include a profile from an explicitly empty order", () => {
    const onProfileOrderChange = vi.fn();
    const container = mount(
      props({
        cards: [
          card({
            profiles: [
              { profileId: "openai:one", type: "oauth", status: "ok" },
              { profileId: "openai:two", type: "oauth", status: "ok" },
            ],
            profileProviderIds: { "openai:one": "openai", "openai:two": "openai" },
            profileAuthProviderIds: {
              "openai:one": "openai",
              "openai:two": "openai",
            },
            profileOwnerProfileIds: { openai: ["openai:one", "openai:two"] },
            profileOrders: { openai: [] },
          }),
        ],
        onProfileOrderChange,
      }),
    );

    expect(text(container.querySelector("section.model-providers__profiles"))).toContain(
      "2 accounts · tried in priority order",
    );
    expect(
      [...container.querySelectorAll<HTMLButtonElement>(".model-providers__profile-grip")].every(
        (grip) => grip.disabled,
      ),
    ).toBe(true);
    button(container.querySelector('[data-profile-id="openai:two"]')!, "Include")?.click();
    expect(onProfileOrderChange).toHaveBeenCalledWith("openai", ["openai:two"]);
  });

  it("does not present a cross-owner profile as a native drag target", () => {
    const onProfileOrderChange = vi.fn();
    const container = mount(
      props({
        cards: [
          card({
            id: "minimax",
            profiles: [
              { profileId: "minimax:one", type: "oauth", status: "ok" },
              { profileId: "minimax:two", type: "oauth", status: "ok" },
              { profileId: "minimax-portal:one", type: "oauth", status: "ok" },
              { profileId: "minimax-portal:two", type: "oauth", status: "ok" },
            ],
            profileProviderIds: {
              "minimax:one": "minimax",
              "minimax:two": "minimax",
              "minimax-portal:one": "minimax-portal",
              "minimax-portal:two": "minimax-portal",
            },
            profileAuthProviderIds: {
              "minimax:one": "minimax",
              "minimax:two": "minimax",
              "minimax-portal:one": "minimax-portal",
              "minimax-portal:two": "minimax-portal",
            },
            profileOrder: [
              "minimax:one",
              "minimax:two",
              "minimax-portal:one",
              "minimax-portal:two",
            ],
            profileOrders: {
              minimax: ["minimax:one", "minimax:two"],
              "minimax-portal": ["minimax-portal:one", "minimax-portal:two"],
            },
          }),
        ],
        onProfileOrderChange,
      }),
    );

    const sourceGrip = container.querySelector<HTMLButtonElement>(
      '[data-profile-id="minimax:two"] .model-providers__profile-grip',
    );
    const sameOwnerTarget = container.querySelector<HTMLElement>('[data-profile-id="minimax:one"]');
    const otherOwnerTarget = container.querySelector<HTMLElement>(
      '[data-profile-id="minimax-portal:one"]',
    );
    const transfer = dragDataTransfer();
    for (const row of [sameOwnerTarget, otherOwnerTarget]) {
      if (row) {
        row.getBoundingClientRect = () => ({ height: 52, top: 0, width: 320 }) as DOMRect;
      }
    }

    sourceGrip?.dispatchEvent(dragEvent("dragstart", transfer));
    otherOwnerTarget?.dispatchEvent(dragEvent("dragover", transfer, 1));
    expect(otherOwnerTarget?.classList.contains("model-providers__profile--drop-before")).toBe(
      false,
    );
    sameOwnerTarget?.dispatchEvent(dragEvent("dragover", transfer, 1));
    expect(sameOwnerTarget?.classList.contains("model-providers__profile--drop-before")).toBe(true);
    expect(onProfileOrderChange).not.toHaveBeenCalled();
  });
});
