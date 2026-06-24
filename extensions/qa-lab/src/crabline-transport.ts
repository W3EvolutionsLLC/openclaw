// Qa Lab plugin module implements Crabline fake-provider transport behavior.
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import {
  CRABLINE_FAKE_PROVIDER_CHANNELS,
  OPENCLAW_CRABLINE_MANIFEST_PATH,
  startOpenClawCrablineAdapter,
  type StartedOpenClawCrablineAdapter,
} from "@openclaw/crabline";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import { createQaBusState, type QaBusState } from "./bus-state.js";
import { QaSuiteInfraError } from "./errors.js";
import { QaStateBackedTransportAdapter } from "./qa-transport.js";
import type {
  QaTransportActionName,
  QaTransportGatewayClient,
  QaTransportGatewayConfig,
  QaTransportReportParams,
  QaTransportState,
} from "./qa-transport.js";
import type {
  QaBusInboundMessageInput,
  QaBusOutboundMessageInput,
  QaBusSearchMessagesInput,
  QaBusWaitForInput,
} from "./runtime-api.js";

const CRABLINE_TRANSPORT_ID = "crabline";
const RECORDER_SYNC_INTERVAL_MS = 50;

export type QaCrablineProviderChannel = "slack" | "telegram" | "whatsapp";

export type QaCrablineChannelDriverSelection = {
  capabilityMatrixPath: "crabline-fake-provider-capabilities.json";
  channel: QaCrablineProviderChannel;
  channelDriver: "crabline";
  smokeArtifactPath: "crabline-fake-provider-smoke.json";
};

type QaCrablineManifest = {
  accessToken?: string;
  adminToken?: string;
  endpoints: {
    adminInboundUrl: string;
    apiRoot: string;
  };
  provider: string;
  recorderPath: string;
  selfJid?: string;
};

type QaStartedOpenClawCrablineAdapter = Omit<
  StartedOpenClawCrablineAdapter,
  "channel" | "manifest"
> & {
  channel: QaCrablineProviderChannel;
  manifest: QaCrablineManifest;
};

type StartQaCrablineAdapter = (params: {
  channel: QaCrablineProviderChannel;
  openclawConfig?: Record<string, unknown> | undefined;
  recorderPath?: string | undefined;
}) => Promise<QaStartedOpenClawCrablineAdapter>;

type QaCrablineTransportState = QaTransportState & {
  cleanup: () => Promise<void>;
  rememberProviderTarget: (providerTargetKey: string, qaTarget: string) => void;
};

const startQaCrablineAdapter = startOpenClawCrablineAdapter as unknown as StartQaCrablineAdapter;

function supportedCrablineFakeProviderChannels() {
  return new Set<string>(CRABLINE_FAKE_PROVIDER_CHANNELS as readonly string[]);
}

function assertCrablineFakeProviderChannelAvailable(channel: QaCrablineProviderChannel) {
  const supportedChannels = supportedCrablineFakeProviderChannels();
  if (supportedChannels.has(channel)) {
    return;
  }
  throw new QaSuiteInfraError(
    "transport_unavailable",
    [
      `@openclaw/crabline does not provide a ${channel} fake provider server.`,
      `installed fake provider channels: ${[...supportedChannels].toSorted().join(", ") || "none"}`,
    ].join(" "),
  );
}

async function waitForCrablineReady(params: {
  accountId: string;
  channel: string;
  gateway: QaTransportGatewayClient;
  timeoutMs?: number;
  pollIntervalMs?: number;
}) {
  const timeoutMs = params.timeoutMs ?? 45_000;
  const pollIntervalMs = params.pollIntervalMs ?? 500;
  const startedAt = Date.now();
  let lastAccountStatus = `no ${params.channel} accounts reported`;
  let lastProbeError: string | null = null;

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const payload = (await params.gateway.call(
        "channels.status",
        { probe: false, timeoutMs: 2_000 },
        { timeoutMs: 5_000 },
      )) as {
        channelAccounts?: Record<
          string,
          Array<{
            accountId?: string;
            running?: boolean;
            restartPending?: boolean;
          }>
        >;
      };
      const accounts = payload.channelAccounts?.[params.channel] ?? [];
      const account = accounts.find((entry) => entry.accountId === params.accountId) ?? accounts[0];
      lastProbeError = null;
      lastAccountStatus = account
        ? JSON.stringify({
            accountId: account.accountId ?? null,
            running: account.running ?? null,
            restartPending: account.restartPending ?? null,
          })
        : `no ${params.channel} accounts reported`;
      if (account?.running && account.restartPending !== true) {
        return;
      }
    } catch (error) {
      lastProbeError = formatErrorMessage(error);
    }
    await sleep(pollIntervalMs);
  }

  throw new QaSuiteInfraError(
    "transport_ready_timeout",
    [
      `timed out after ${timeoutMs}ms waiting for ${params.channel} ready`,
      `last status: ${lastAccountStatus}`,
      ...(lastProbeError ? [`last probe error: ${lastProbeError}`] : []),
    ].join("; "),
  );
}

async function postCrablineInbound(params: {
  adapter: QaStartedOpenClawCrablineAdapter;
  providerBody: Record<string, unknown>;
}) {
  const { response, release } = await fetchWithSsrFGuard({
    url: params.adapter.manifest.endpoints.adminInboundUrl,
    init: {
      body: JSON.stringify(params.providerBody),
      headers: {
        ...(params.adapter.manifest.adminToken
          ? { authorization: `Bearer ${params.adapter.manifest.adminToken}` }
          : {}),
        "content-type": "application/json",
      },
      method: "POST",
    },
    policy: { allowPrivateNetwork: true },
    auditContext: `qa-lab-crabline-${params.adapter.channel}-inbound`,
  });
  try {
    if (!response.ok) {
      throw new Error(
        `Crabline ${params.adapter.channel} inbound injection failed with HTTP ${response.status}.`,
      );
    }
  } finally {
    await release();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isQaTransportGatewayConfig(value: unknown): value is QaTransportGatewayConfig {
  if (!isRecord(value)) {
    return false;
  }
  return (
    (value.channels === undefined || isRecord(value.channels)) &&
    (value.messages === undefined || isRecord(value.messages))
  );
}

function toQaTransportGatewayConfig(value: unknown): QaTransportGatewayConfig {
  if (!isQaTransportGatewayConfig(value)) {
    throw new Error("Crabline returned an invalid OpenClaw gateway config.");
  }
  return value;
}

function createCrablineRuntimeEnvPatch(params: {
  adapter: QaStartedOpenClawCrablineAdapter;
  preloadPath?: string | undefined;
}): NodeJS.ProcessEnv {
  const adapter = params.adapter;
  const env = adapter.createChannelDriverSmokeEnv({});
  if (adapter.manifest.provider === "slack" && env.SLACK_API_URL) {
    const { SLACK_API_URL, ...rest } = env;
    return {
      ...rest,
      OPENCLAW_SLACK_API_URL: SLACK_API_URL,
    };
  }
  if (adapter.manifest.provider === "whatsapp") {
    if (!params.preloadPath) {
      throw new Error("WhatsApp fake-provider preload path was not staged.");
    }
    const {
      CRABLINE_WHATSAPP_ACCESS_TOKEN,
      CRABLINE_WHATSAPP_API_ROOT,
      CRABLINE_WHATSAPP_SELF_JID,
      ...rest
    } = env;
    return {
      ...rest,
      NODE_OPTIONS: appendNodeOption(
        process.env.NODE_OPTIONS,
        `--import=${pathToFileURL(params.preloadPath).href}`,
      ),
      OPENCLAW_WHATSAPP_FAKE_PROVIDER_ACCESS_TOKEN: CRABLINE_WHATSAPP_ACCESS_TOKEN,
      OPENCLAW_WHATSAPP_FAKE_PROVIDER_ACCOUNT_ID: adapter.accountId,
      OPENCLAW_WHATSAPP_FAKE_PROVIDER_API_ROOT: CRABLINE_WHATSAPP_API_ROOT,
      OPENCLAW_WHATSAPP_FAKE_PROVIDER_SELF_JID: CRABLINE_WHATSAPP_SELF_JID,
    };
  }
  return env;
}

function appendNodeOption(raw: string | undefined, option: string) {
  const parts = (raw ?? "").split(/\s+/u).filter(Boolean);
  return parts.includes(option) ? parts.join(" ") : [...parts, option].join(" ");
}

function createWhatsAppPreloadSource() {
  return `// Generated by QA Lab to register a WhatsApp fake-provider controller.
const REGISTRATION_STATE_KEY = Symbol.for("openclaw.qaLab.whatsappFakeProviderRegistration");
const WHATSAPP_CONNECTION_REGISTRY_KEY = Symbol.for("openclaw.whatsapp.connectionControllerRegistry");

function readNonEmptyString(value) {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed || null;
}

function e164FromJid(jid) {
  const waId = String(jid).split("@", 1)[0]?.split(":", 1)[0] ?? "";
  return /^\\d+$/u.test(waId) ? \`+\${waId}\` : null;
}

function getConnectionRegistryState() {
  const existing = globalThis[WHATSAPP_CONNECTION_REGISTRY_KEY];
  if (existing) {
    return existing;
  }
  const created = { controllers: new Map() };
  globalThis[WHATSAPP_CONNECTION_REGISTRY_KEY] = created;
  return created;
}

function readRegistrationState() {
  return globalThis[REGISTRATION_STATE_KEY] ?? null;
}

function writeRegistrationState(state) {
  if (state) {
    globalThis[REGISTRATION_STATE_KEY] = state;
  } else {
    delete globalThis[REGISTRATION_STATE_KEY];
  }
}

function registerController(accountId, controller) {
  getConnectionRegistryState().controllers.set(accountId, controller);
}

function unregisterController(accountId, controller) {
  const controllers = getConnectionRegistryState().controllers;
  if (controllers.get(accountId) === controller) {
    controllers.delete(accountId);
  }
}

function createActiveListener(socket) {
  return {
    async close() {},
    async sendComposingTo(to) {
      await socket.sendPresenceUpdate("composing", to);
    },
    async sendMessage(to, text, mediaBuffer, mediaType) {
      if (mediaBuffer || mediaType) {
        throw new Error("WhatsApp fake-provider controller supports text sends only.");
      }
      const message = await socket.sendMessage(to, { text });
      const key = message.key ?? {};
      const messageId = typeof key.id === "string" && key.id.trim() ? key.id : "unknown";
      return {
        kind: "text",
        keys: [{
          ...(key.participant ? { participant: key.participant } : {}),
          fromMe: key.fromMe === true,
          id: messageId,
          remoteJid: key.remoteJid,
        }],
        messageId,
        providerAccepted: true,
      };
    },
    async sendPoll() {
      throw new Error("WhatsApp fake-provider controller does not support poll sends.");
    },
    async sendReaction() {
      throw new Error("WhatsApp fake-provider controller does not support reaction sends.");
    },
  };
}

async function registerFromEnv() {
  const accessToken = readNonEmptyString(process.env.OPENCLAW_WHATSAPP_FAKE_PROVIDER_ACCESS_TOKEN);
  const apiRoot = readNonEmptyString(process.env.OPENCLAW_WHATSAPP_FAKE_PROVIDER_API_ROOT);
  if (!accessToken || !apiRoot) {
    return;
  }
  const accountId = readNonEmptyString(process.env.OPENCLAW_WHATSAPP_FAKE_PROVIDER_ACCOUNT_ID) ?? "default";
  const selfJid = readNonEmptyString(process.env.OPENCLAW_WHATSAPP_FAKE_PROVIDER_SELF_JID) ?? "15550000000@s.whatsapp.net";
  const existing = readRegistrationState();
  if (existing?.accountId === accountId) {
    return;
  }
  if (existing) {
    unregisterController(existing.accountId, existing.controller);
  }
  const crabline = await import("@openclaw/crabline");
  if (typeof crabline.createWhatsAppBaileysMockSocket !== "function") {
    throw new Error("@openclaw/crabline does not expose createWhatsAppBaileysMockSocket(). Install a version with WhatsApp fake-provider support.");
  }
  const socket = crabline.createWhatsAppBaileysMockSocket({ accessToken, apiRoot, selfJid });
  const listener = createActiveListener(socket);
  const controller = {
    getActiveListener: () => listener,
    getCurrentSock: () => socket,
    getSelfIdentity: () => ({
      e164: e164FromJid(selfJid),
      jid: selfJid,
      lid: null,
    }),
  };
  registerController(accountId, controller);
  writeRegistrationState({ accountId, controller });
}

await registerFromEnv();
`;
}

async function stageWhatsAppAuthDir(params: {
  adapter: QaStartedOpenClawCrablineAdapter;
  outputDir: string;
}): Promise<string | undefined> {
  if (params.adapter.channel !== "whatsapp") {
    return undefined;
  }
  const selfJid = params.adapter.manifest.selfJid?.trim() || "15550000000@s.whatsapp.net";
  const authDir = path.join(params.outputDir, "artifacts", "crabline", "whatsapp-auth");
  await fs.mkdir(authDir, { recursive: true, mode: 0o700 });
  await fs.writeFile(
    path.join(authDir, "creds.json"),
    `${JSON.stringify({ me: { id: selfJid } }, null, 2)}\n`,
    {
      encoding: "utf8",
      mode: 0o600,
    },
  );
  return authDir;
}

async function stageWhatsAppPreload(params: {
  adapter: QaStartedOpenClawCrablineAdapter;
  outputDir: string;
}): Promise<string | undefined> {
  if (params.adapter.channel !== "whatsapp") {
    return undefined;
  }
  const preloadPath = path.join(params.outputDir, "artifacts", "crabline", "whatsapp-preload.mjs");
  await fs.mkdir(path.dirname(preloadPath), { recursive: true });
  await fs.writeFile(preloadPath, createWhatsAppPreloadSource(), {
    encoding: "utf8",
    mode: 0o600,
  });
  return preloadPath;
}

function createCrablineState(params: {
  adapter: QaStartedOpenClawCrablineAdapter;
  state: QaBusState;
}): QaCrablineTransportState {
  const baseState = params.state;
  const targetByProviderTarget = new Map<string, string>();
  let recorderLineCursor = 0;
  let syncPromise: Promise<void> | null = null;

  const syncRecorder = async () => {
    if (syncPromise) {
      return await syncPromise;
    }
    syncPromise = (async () => {
      const text = await fs
        .readFile(params.adapter.manifest.recorderPath, "utf8")
        .catch((error: unknown) => {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            return "";
          }
          throw error;
        });
      const lines = text.split(/\r?\n/u).filter((line) => line.trim().length > 0);
      for (const line of lines.slice(recorderLineCursor)) {
        const parsed = JSON.parse(line) as unknown;
        const outbound = params.adapter.createOutboundFromRecorderEvent({
          event: parsed,
          targetByProviderTarget,
        }) as QaBusOutboundMessageInput | null;
        if (outbound) {
          baseState.addOutboundMessage(outbound);
        }
      }
      recorderLineCursor = lines.length;
    })();
    try {
      await syncPromise;
    } finally {
      syncPromise = null;
    }
  };

  const interval = setInterval(() => {
    void syncRecorder().catch(() => undefined);
  }, RECORDER_SYNC_INTERVAL_MS);
  interval.unref?.();

  return {
    async reset() {
      await syncRecorder();
      baseState.reset();
      targetByProviderTarget.clear();
      recorderLineCursor = await fs
        .readFile(params.adapter.manifest.recorderPath, "utf8")
        .then((text) => text.split(/\r?\n/u).filter((line) => line.trim().length > 0).length)
        .catch(() => 0);
    },
    getSnapshot: baseState.getSnapshot.bind(baseState),
    async addInboundMessage(input: QaBusInboundMessageInput) {
      const providerInbound = params.adapter.createInbound({ input });
      targetByProviderTarget.set(providerInbound.providerTargetKey, providerInbound.qaTarget);
      const message = baseState.addInboundMessage({
        ...input,
        conversation: providerInbound.stateConversation,
        ...(providerInbound.threadId ? { threadId: providerInbound.threadId } : {}),
      });
      await postCrablineInbound({
        adapter: params.adapter,
        providerBody: providerInbound.providerBody,
      });
      return message;
    },
    rememberProviderTarget(providerTargetKey, qaTarget) {
      targetByProviderTarget.set(providerTargetKey, qaTarget);
    },
    addOutboundMessage: baseState.addOutboundMessage.bind(baseState),
    readMessage: baseState.readMessage.bind(baseState),
    async searchMessages(input: QaBusSearchMessagesInput) {
      await syncRecorder();
      return baseState.searchMessages(input);
    },
    async waitFor(input: QaBusWaitForInput) {
      await syncRecorder();
      return await baseState.waitFor(input);
    },
    async cleanup() {
      clearInterval(interval);
      await syncRecorder();
      await params.adapter.close();
    },
  };
}

class QaCrablineTransport extends QaStateBackedTransportAdapter {
  readonly #adapter: QaStartedOpenClawCrablineAdapter;
  readonly #authDir: string | undefined;
  readonly #preloadPath: string | undefined;
  readonly #selection: QaCrablineChannelDriverSelection;
  readonly #state: QaCrablineTransportState;

  constructor(params: {
    adapter: QaStartedOpenClawCrablineAdapter;
    authDir?: string | undefined;
    preloadPath?: string | undefined;
    selection: QaCrablineChannelDriverSelection;
    state: QaCrablineTransportState;
  }) {
    super({
      id: CRABLINE_TRANSPORT_ID,
      label: `crabline fake ${params.selection.channel}`,
      accountId: params.adapter.accountId,
      requiredPluginIds: params.adapter.requiredPluginIds,
      state: params.state,
    });
    this.#adapter = params.adapter;
    this.#authDir = params.authDir;
    this.#preloadPath = params.preloadPath;
    this.#selection = params.selection;
    this.#state = params.state;
  }

  createGatewayConfig = (params: { baseUrl: string }): QaTransportGatewayConfig => {
    const config = toQaTransportGatewayConfig(this.#adapter.createGatewayConfig(params));
    if (this.#adapter.channel !== "whatsapp" || !this.#authDir) {
      return config;
    }
    const channels = isRecord(config.channels) ? config.channels : {};
    const whatsapp = isRecord(channels.whatsapp) ? channels.whatsapp : {};
    const accounts = isRecord(whatsapp.accounts) ? whatsapp.accounts : {};
    const accountConfig = isRecord(accounts[this.#adapter.accountId])
      ? accounts[this.#adapter.accountId]
      : {};
    return {
      ...config,
      channels: {
        ...channels,
        whatsapp: {
          ...whatsapp,
          accounts: {
            ...accounts,
            [this.#adapter.accountId]: {
              ...accountConfig,
              authDir: this.#authDir,
              enabled: true,
            },
          },
        },
      },
    };
  };

  waitReady = (params: {
    gateway: QaTransportGatewayClient;
    timeoutMs?: number;
    pollIntervalMs?: number;
  }) =>
    waitForCrablineReady({
      ...params,
      accountId: this.#adapter.accountId,
      channel: this.#adapter.channel,
    });

  buildAgentDelivery = ({ target }: { target: string }) => {
    const delivery = this.#adapter.createAgentDelivery({ target });
    this.#state.rememberProviderTarget(delivery.to ?? delivery.replyTo, target);
    return delivery;
  };

  createRuntimeEnvPatch = () =>
    createCrablineRuntimeEnvPatch({
      adapter: this.#adapter,
      preloadPath: this.#preloadPath,
    });

  handleAction = async (_params: {
    action: QaTransportActionName;
    args: Record<string, unknown>;
    cfg: OpenClawConfig;
    accountId?: string | null;
  }) => {
    throw new Error(`Crabline fake-provider transport does not support ${_params.action} yet.`);
  };

  createReportNotes = (_params: QaTransportReportParams) => [
    `Runs OpenClaw's ${this.#selection.channel} channel plugin against a Crabline fake provider server.`,
    "No live channel service or external credential lease is required.",
  ];

  async cleanup() {
    await this.#state.cleanup();
  }
}

export async function createQaCrablineTransportAdapter(params: {
  outputDir: string;
  selection: QaCrablineChannelDriverSelection;
  state?: QaBusState;
}) {
  assertCrablineFakeProviderChannelAvailable(params.selection.channel);
  const recorderPath = path.join(
    params.outputDir,
    "artifacts",
    "crabline",
    `${params.selection.channel}-fake-provider.jsonl`,
  );
  await fs.mkdir(path.dirname(recorderPath), { recursive: true });
  const adapter = await startQaCrablineAdapter({
    channel: params.selection.channel,
    openclawConfig: {},
    recorderPath,
  });
  const authDir = await stageWhatsAppAuthDir({
    adapter,
    outputDir: params.outputDir,
  });
  const preloadPath = await stageWhatsAppPreload({
    adapter,
    outputDir: params.outputDir,
  });
  await fs.writeFile(
    path.join(params.outputDir, OPENCLAW_CRABLINE_MANIFEST_PATH),
    `${JSON.stringify(adapter.manifest, null, 2)}\n`,
    "utf8",
  );

  return new QaCrablineTransport({
    adapter,
    authDir,
    preloadPath,
    selection: params.selection,
    state: createCrablineState({
      adapter,
      state: params.state ?? createQaBusState(),
    }),
  });
}
