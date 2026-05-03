import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import { z } from "zod";
import { startQaGatewayChild } from "../../gateway-child.js";
import { DEFAULT_QA_LIVE_PROVIDER_MODE } from "../../providers/index.js";
import {
  defaultQaModelForMode,
  normalizeQaProviderMode,
  type QaProviderModeInput,
} from "../../run-config.js";
import {
  acquireQaCredentialLease,
  startQaCredentialLeaseHeartbeat,
  type QaCredentialRole,
} from "../shared/credential-lease.runtime.js";
import { startQaLiveLaneGateway } from "../shared/live-gateway.runtime.js";
import { appendLiveLaneIssue, buildLiveLaneArtifactsError } from "../shared/live-lane-helpers.js";
import {
  collectLiveTransportStandardScenarioCoverage,
  selectLiveTransportScenarios,
  type LiveTransportScenarioDefinition,
} from "../shared/live-transport-scenarios.js";

type SlackQaRuntimeEnv = {
  channelId: string;
  driverBotToken: string;
  sutBotToken: string;
  sutAppToken: string;
};

type SlackQaScenarioId = "slack-canary" | "slack-mention-gating";

type SlackQaScenarioRun = {
  expectReply: boolean;
  input: string;
  matchText?: string;
  expectedTextIncludes?: string[];
};

type SlackQaScenarioDefinition = LiveTransportScenarioDefinition<SlackQaScenarioId> & {
  buildRun: (sutUserId: string) => SlackQaScenarioRun;
};

type SlackAuthTestResult = {
  ok: boolean;
  team_id?: string;
  user_id?: string;
  bot_id?: string;
  error?: string;
};

type SlackPostMessageResult = {
  ok: boolean;
  channel?: string;
  ts?: string;
  error?: string;
};

type SlackMessage = {
  bot_id?: string;
  subtype?: string;
  text?: string;
  thread_ts?: string;
  ts?: string;
  user?: string;
};

type SlackHistoryResult = {
  ok: boolean;
  error?: string;
  messages?: SlackMessage[];
};

type SlackObservedMessage = {
  messageTs: string;
  channelId: string;
  senderId?: string;
  senderBotId?: string;
  senderIsBot: boolean;
  scenarioId?: string;
  scenarioTitle?: string;
  matchedScenario?: boolean;
  text: string;
  threadTs?: string;
  observedAt: string;
};

type SlackObservedMessageArtifact = {
  messageTs?: string;
  channelId?: string;
  senderId?: string;
  senderBotId?: string;
  senderIsBot: boolean;
  scenarioId?: string;
  scenarioTitle?: string;
  matchedScenario?: boolean;
  text?: string;
  threadTs?: string;
  observedAt?: string;
};

type SlackQaScenarioResult = {
  id: string;
  title: string;
  status: "pass" | "fail";
  details: string;
  rttMs?: number;
  requestStartedAt?: string;
  responseObservedAt?: string;
  sentMessageTs?: string;
  responseMessageTs?: string;
};

type SlackQaRunResult = {
  outputDir: string;
  reportPath: string;
  summaryPath: string;
  observedMessagesPath: string;
  gatewayDebugDirPath?: string;
  scenarios: SlackQaScenarioResult[];
};

type SlackQaSummary = {
  credentials: {
    credentialId?: string;
    kind: string;
    ownerId?: string;
    role?: QaCredentialRole;
    source: "convex" | "env";
  };
  channelId: string;
  startedAt: string;
  finishedAt: string;
  cleanupIssues: string[];
  counts: {
    total: number;
    passed: number;
    failed: number;
  };
  scenarios: SlackQaScenarioResult[];
};

const SLACK_QA_ENV_KEYS = [
  "OPENCLAW_QA_SLACK_CHANNEL_ID",
  "OPENCLAW_QA_SLACK_DRIVER_BOT_TOKEN",
  "OPENCLAW_QA_SLACK_SUT_BOT_TOKEN",
  "OPENCLAW_QA_SLACK_SUT_APP_TOKEN",
] as const;
const SLACK_QA_CAPTURE_CONTENT_ENV = "OPENCLAW_QA_SLACK_CAPTURE_CONTENT";
const QA_REDACT_PUBLIC_METADATA_ENV = "OPENCLAW_QA_REDACT_PUBLIC_METADATA";

const slackQaCredentialPayloadSchema = z.object({
  channelId: z.string().trim().min(1),
  driverBotToken: z.string().trim().min(1),
  sutBotToken: z.string().trim().min(1),
  sutAppToken: z.string().trim().min(1),
});

const SLACK_QA_SCENARIOS: SlackQaScenarioDefinition[] = [
  {
    id: "slack-canary",
    standardId: "canary",
    title: "Slack canary echo",
    timeoutMs: 45_000,
    buildRun: (sutUserId) => {
      const token = `SLACK_QA_ECHO_${randomUUID().slice(0, 8).toUpperCase()}`;
      return {
        expectReply: true,
        input: `<@${sutUserId}> reply with only this exact marker: ${token}`,
        expectedTextIncludes: [token],
        matchText: token,
      };
    },
  },
  {
    id: "slack-mention-gating",
    standardId: "mention-gating",
    title: "Slack unmentioned message does not trigger",
    timeoutMs: 8_000,
    buildRun: () => {
      const token = `SLACK_QA_NOMENTION_${randomUUID().slice(0, 8).toUpperCase()}`;
      return {
        expectReply: false,
        input: `reply with only this exact marker: ${token}`,
        matchText: token,
      };
    },
  },
];

const SLACK_QA_STANDARD_SCENARIO_IDS = collectLiveTransportStandardScenarioCoverage({
  scenarios: SLACK_QA_SCENARIOS,
});

function resolveEnvValue(env: NodeJS.ProcessEnv, key: (typeof SLACK_QA_ENV_KEYS)[number]) {
  const value = env[key]?.trim();
  if (!value) {
    throw new Error(`Missing ${key}.`);
  }
  return value;
}

function isTruthyOptIn(value: string | undefined) {
  const normalized = value?.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

function normalizeSlackChannelId(value: string, label: string) {
  const normalized = value.trim();
  if (!/^[CGD][A-Z0-9]{2,}$/u.test(normalized)) {
    throw new Error(`${label} must be a Slack channel id beginning with C, G, or D.`);
  }
  return normalized;
}

function resolveSlackQaRuntimeEnv(env: NodeJS.ProcessEnv = process.env): SlackQaRuntimeEnv {
  return {
    channelId: normalizeSlackChannelId(
      resolveEnvValue(env, "OPENCLAW_QA_SLACK_CHANNEL_ID"),
      "OPENCLAW_QA_SLACK_CHANNEL_ID",
    ),
    driverBotToken: resolveEnvValue(env, "OPENCLAW_QA_SLACK_DRIVER_BOT_TOKEN"),
    sutBotToken: resolveEnvValue(env, "OPENCLAW_QA_SLACK_SUT_BOT_TOKEN"),
    sutAppToken: resolveEnvValue(env, "OPENCLAW_QA_SLACK_SUT_APP_TOKEN"),
  };
}

function parseSlackQaCredentialPayload(payload: unknown): SlackQaRuntimeEnv {
  const parsed = slackQaCredentialPayloadSchema.parse(payload);
  return {
    channelId: normalizeSlackChannelId(parsed.channelId, "Slack credential payload channelId"),
    driverBotToken: parsed.driverBotToken,
    sutBotToken: parsed.sutBotToken,
    sutAppToken: parsed.sutAppToken,
  };
}

function buildSlackQaConfig(
  baseCfg: OpenClawConfig,
  params: {
    channelId: string;
    driverBotId: string;
    sutAccountId: string;
    sutBotToken: string;
    sutAppToken: string;
  },
): OpenClawConfig {
  const pluginAllow = [...new Set([...(baseCfg.plugins?.allow ?? []), "slack"])];
  const pluginEntries = {
    ...baseCfg.plugins?.entries,
    slack: { enabled: true },
  };
  return {
    ...baseCfg,
    agents: {
      ...baseCfg.agents,
      defaults: {
        ...baseCfg.agents?.defaults,
        skipBootstrap: true,
      },
    },
    plugins: {
      ...baseCfg.plugins,
      allow: pluginAllow,
      entries: pluginEntries,
    },
    messages: {
      ...baseCfg.messages,
      groupChat: {
        ...baseCfg.messages?.groupChat,
        visibleReplies: "automatic",
      },
    },
    channels: {
      ...baseCfg.channels,
      slack: {
        enabled: true,
        defaultAccount: params.sutAccountId,
        groupPolicy: "allowlist",
        requireMention: true,
        allowBots: true,
        accounts: {
          [params.sutAccountId]: {
            enabled: true,
            mode: "socket",
            botToken: params.sutBotToken,
            appToken: params.sutAppToken,
            dmPolicy: "disabled",
            groupPolicy: "allowlist",
            requireMention: true,
            allowBots: true,
            channels: {
              [params.channelId]: {
                enabled: true,
                requireMention: true,
                allowBots: true,
                users: [params.driverBotId],
              },
            },
          },
        },
      },
    },
  };
}

async function callSlackApi<T>(
  token: string,
  method: string,
  body?: Record<string, boolean | number | string | null | undefined>,
  timeoutMs = 15_000,
): Promise<T> {
  const form = new URLSearchParams();
  for (const [key, value] of Object.entries(body ?? {})) {
    if (value !== undefined && value !== null) {
      form.set(key, String(value));
    }
  }
  const { response, release } = await fetchWithSsrFGuard({
    url: `https://slack.com/api/${method}`,
    init: {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/x-www-form-urlencoded; charset=utf-8",
      },
      body: form,
    },
    signal: AbortSignal.timeout(timeoutMs),
    policy: { hostnameAllowlist: ["slack.com"] },
    auditContext: "qa-lab-slack-live",
  });
  try {
    const payload = (await response.json()) as { ok?: boolean; error?: string };
    if (!response.ok || payload.ok !== true) {
      throw new Error(payload.error?.trim() || `${method} failed with status ${response.status}`);
    }
    return payload as T;
  } finally {
    await release();
  }
}

async function getSlackBotIdentity(token: string) {
  const result = await callSlackApi<SlackAuthTestResult>(token, "auth.test");
  if (!result.user_id) {
    throw new Error("Slack auth.test did not return a bot user id.");
  }
  return result;
}

async function sendSlackMessage(token: string, channelId: string, text: string) {
  const result = await callSlackApi<SlackPostMessageResult>(token, "chat.postMessage", {
    channel: channelId,
    text,
    unfurl_links: false,
    unfurl_media: false,
  });
  if (!result.ts || !result.channel) {
    throw new Error("Slack chat.postMessage did not return a channel and ts.");
  }
  return { channelId: result.channel, messageTs: result.ts };
}

function slackTsToNumber(ts: string | undefined) {
  const parsed = Number(ts);
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeSlackObservedMessage(params: {
  channelId: string;
  message: SlackMessage;
  observedAt: string;
}): SlackObservedMessage | null {
  const messageTs = params.message.ts?.trim();
  if (!messageTs) {
    return null;
  }
  return {
    messageTs,
    channelId: params.channelId,
    senderId: params.message.user,
    senderBotId: params.message.bot_id,
    senderIsBot: Boolean(params.message.bot_id),
    text: params.message.text ?? "",
    threadTs: params.message.thread_ts,
    observedAt: params.observedAt,
  };
}

async function waitForSlackMessage(params: {
  token: string;
  channelId: string;
  afterTs: string;
  timeoutMs: number;
  observedMessages: SlackObservedMessage[];
  observationScenarioId: string;
  observationScenarioTitle: string;
  predicate: (message: SlackObservedMessage) => boolean;
}) {
  const startedAt = Date.now();
  let lastPollingError: unknown;
  const seen = new Set<string>();
  while (Date.now() - startedAt < params.timeoutMs) {
    try {
      const history = await callSlackApi<SlackHistoryResult>(
        params.token,
        "conversations.history",
        {
          channel: params.channelId,
          oldest: params.afterTs,
          inclusive: false,
          limit: 25,
        },
        15_000,
      );
      lastPollingError = undefined;
      const observedAtMs = Date.now();
      const observedAt = new Date(observedAtMs).toISOString();
      const messages = (history.messages ?? [])
        .filter((message) => slackTsToNumber(message.ts) > slackTsToNumber(params.afterTs))
        .toSorted((left, right) => slackTsToNumber(left.ts) - slackTsToNumber(right.ts));
      for (const message of messages) {
        const normalized = normalizeSlackObservedMessage({
          channelId: params.channelId,
          message,
          observedAt,
        });
        if (!normalized || seen.has(normalized.messageTs)) {
          continue;
        }
        seen.add(normalized.messageTs);
        const matchedScenario = params.predicate(normalized);
        const observedMessage: SlackObservedMessage = {
          ...normalized,
          scenarioId: params.observationScenarioId,
          scenarioTitle: params.observationScenarioTitle,
          matchedScenario,
        };
        params.observedMessages.push(observedMessage);
        if (matchedScenario) {
          return { message: observedMessage, observedAtMs };
        }
      }
    } catch (error) {
      lastPollingError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 750));
  }
  const timeoutMessage = `timed out after ${params.timeoutMs}ms waiting for Slack message`;
  if (lastPollingError) {
    throw new Error(
      `${timeoutMessage}; last polling error: ${formatErrorMessage(lastPollingError)}`,
    );
  }
  throw new Error(timeoutMessage);
}

async function waitForSlackChannelRunning(
  gateway: Awaited<ReturnType<typeof startQaGatewayChild>>,
  accountId: string,
) {
  const startedAt = Date.now();
  let lastStatus:
    | {
        running?: boolean;
        connected?: boolean;
        restartPending?: boolean;
        lastConnectedAt?: number;
        lastDisconnect?: unknown;
        lastError?: string;
      }
    | undefined;
  while (Date.now() - startedAt < 45_000) {
    try {
      const payload = (await gateway.call(
        "channels.status",
        { probe: false, timeoutMs: 2_000 },
        { timeoutMs: 5_000 },
      )) as {
        channelAccounts?: Record<
          string,
          Array<{
            accountId?: string;
            running?: boolean;
            connected?: boolean;
            restartPending?: boolean;
            lastConnectedAt?: number;
            lastDisconnect?: unknown;
            lastError?: string;
          }>
        >;
      };
      const accounts = payload.channelAccounts?.slack ?? [];
      const match = accounts.find((entry) => entry.accountId === accountId);
      lastStatus = match
        ? {
            running: match.running,
            connected: match.connected,
            restartPending: match.restartPending,
            lastConnectedAt: match.lastConnectedAt,
            lastDisconnect: match.lastDisconnect,
            lastError: match.lastError,
          }
        : undefined;
      if (match?.running && match.connected === true && match.restartPending !== true) {
        return;
      }
    } catch {
      // retry
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  const details = lastStatus
    ? ` (last status: running=${String(lastStatus.running)} connected=${String(lastStatus.connected)} restartPending=${String(lastStatus.restartPending)} lastConnectedAt=${String(lastStatus.lastConnectedAt)} lastError=${lastStatus.lastError ?? "null"} lastDisconnect=${JSON.stringify(lastStatus.lastDisconnect)})`
    : "";
  throw new Error(`slack account "${accountId}" did not become connected${details}`);
}

function renderSlackQaMarkdown(params: {
  cleanupIssues: string[];
  credentialSource: "convex" | "env";
  redactMetadata: boolean;
  channelId: string;
  gatewayDebugDirPath?: string;
  startedAt: string;
  finishedAt: string;
  scenarios: SlackQaScenarioResult[];
}) {
  const lines = [
    "# Slack QA Report",
    "",
    `- Credential source: \`${params.credentialSource}\``,
    `- Channel: \`${params.channelId}\``,
    `- Metadata redaction: \`${params.redactMetadata ? "enabled" : "disabled"}\``,
    `- Started: ${params.startedAt}`,
    `- Finished: ${params.finishedAt}`,
    "",
    "## Scenarios",
    "",
  ];
  for (const scenario of params.scenarios) {
    lines.push(`### ${scenario.title}`);
    lines.push("");
    lines.push(`- Status: ${scenario.status}`);
    lines.push(`- Details: ${scenario.details}`);
    if (scenario.rttMs !== undefined) {
      lines.push(`- RTT: ${scenario.rttMs}ms`);
    }
    lines.push("");
  }
  if (params.gatewayDebugDirPath) {
    lines.push("## Gateway Debug Logs");
    lines.push("");
    lines.push(`- Preserved at: \`${params.gatewayDebugDirPath}\``);
    lines.push("");
  }
  if (params.cleanupIssues.length > 0) {
    lines.push("## Cleanup");
    lines.push("");
    for (const issue of params.cleanupIssues) {
      lines.push(`- ${issue}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

function buildObservedMessagesArtifact(params: {
  observedMessages: SlackObservedMessage[];
  includeContent: boolean;
  redactMetadata: boolean;
}) {
  return params.observedMessages.map<SlackObservedMessageArtifact>((message) => {
    const scenarioContext = {
      ...(message.scenarioId ? { scenarioId: message.scenarioId } : {}),
      ...(message.scenarioTitle ? { scenarioTitle: message.scenarioTitle } : {}),
      ...(typeof message.matchedScenario === "boolean"
        ? { matchedScenario: message.matchedScenario }
        : {}),
    };
    const base = params.redactMetadata
      ? {
          ...scenarioContext,
          senderIsBot: message.senderIsBot,
        }
      : {
          ...scenarioContext,
          messageTs: message.messageTs,
          channelId: message.channelId,
          senderId: message.senderId,
          senderBotId: message.senderBotId,
          senderIsBot: message.senderIsBot,
          threadTs: message.threadTs,
          observedAt: message.observedAt,
        };
    if (!params.includeContent) {
      return base;
    }
    return {
      ...base,
      text: message.text,
    };
  });
}

function findScenario(ids?: string[]) {
  return selectLiveTransportScenarios({
    ids,
    laneLabel: "Slack",
    scenarios: SLACK_QA_SCENARIOS,
  });
}

function matchesSlackScenarioReply(params: {
  channelId: string;
  message: SlackObservedMessage;
  matchText?: string;
  sutBotUserId: string;
}) {
  return (
    params.message.channelId === params.channelId &&
    params.message.senderId === params.sutBotUserId &&
    Boolean(params.matchText && params.message.text.includes(params.matchText))
  );
}

function assertSlackScenarioReply(params: {
  expectedTextIncludes?: string[];
  message: SlackObservedMessage;
}) {
  if (!params.message.text.trim()) {
    throw new Error(`reply message ${params.message.messageTs} was empty`);
  }
  for (const expected of params.expectedTextIncludes ?? []) {
    if (!params.message.text.includes(expected)) {
      throw new Error(
        `reply message ${params.message.messageTs} missing expected text: ${expected}`,
      );
    }
  }
}

export async function runSlackQaLive(params: {
  repoRoot?: string;
  outputDir?: string;
  providerMode?: QaProviderModeInput;
  primaryModel?: string;
  alternateModel?: string;
  fastMode?: boolean;
  scenarioIds?: string[];
  sutAccountId?: string;
  credentialSource?: string;
  credentialRole?: string;
}): Promise<SlackQaRunResult> {
  const repoRoot = path.resolve(params.repoRoot ?? process.cwd());
  const outputDir =
    params.outputDir ??
    path.join(repoRoot, ".artifacts", "qa-e2e", `slack-${Date.now().toString(36)}`);
  await fs.mkdir(outputDir, { recursive: true });

  const providerMode = normalizeQaProviderMode(
    params.providerMode ?? DEFAULT_QA_LIVE_PROVIDER_MODE,
  );
  const primaryModel = params.primaryModel?.trim() || defaultQaModelForMode(providerMode);
  const alternateModel =
    params.alternateModel?.trim() || defaultQaModelForMode(providerMode, true) || primaryModel;
  const sutAccountId = params.sutAccountId?.trim() || "sut";
  const scenarios = findScenario(params.scenarioIds);

  const credentialLease = await acquireQaCredentialLease({
    kind: "slack",
    source: params.credentialSource,
    role: params.credentialRole,
    resolveEnvPayload: () => resolveSlackQaRuntimeEnv(),
    parsePayload: parseSlackQaCredentialPayload,
  });
  const leaseHeartbeat = startQaCredentialLeaseHeartbeat(credentialLease);
  const assertLeaseHealthy = () => {
    leaseHeartbeat.throwIfFailed();
  };

  const runtimeEnv = credentialLease.payload;
  const observedMessages: SlackObservedMessage[] = [];
  const redactPublicMetadata = isTruthyOptIn(process.env[QA_REDACT_PUBLIC_METADATA_ENV]);
  const includeObservedMessageContent = isTruthyOptIn(process.env[SLACK_QA_CAPTURE_CONTENT_ENV]);
  const startedAt = new Date().toISOString();
  const scenarioResults: SlackQaScenarioResult[] = [];
  const cleanupIssues: string[] = [];
  const gatewayDebugDirPath = path.join(outputDir, "gateway-debug");
  let preservedGatewayDebugArtifacts = false;
  try {
    const [driverIdentity, sutIdentity] = await Promise.all([
      getSlackBotIdentity(runtimeEnv.driverBotToken),
      getSlackBotIdentity(runtimeEnv.sutBotToken),
    ]);
    const driverBotUserId = driverIdentity.user_id;
    const sutBotUserId = sutIdentity.user_id;
    if (!driverBotUserId || !sutBotUserId) {
      throw new Error("Slack QA requires auth.test to return bot user ids.");
    }
    if (driverBotUserId === sutBotUserId) {
      throw new Error("Slack QA requires two distinct bots for driver and SUT.");
    }

    const gatewayHarness = await startQaLiveLaneGateway({
      repoRoot,
      transport: {
        requiredPluginIds: [],
        createGatewayConfig: () => ({}),
      },
      transportBaseUrl: "http://127.0.0.1:0",
      providerMode,
      primaryModel,
      alternateModel,
      fastMode: params.fastMode,
      controlUiEnabled: false,
      mutateConfig: (cfg) =>
        buildSlackQaConfig(cfg, {
          channelId: runtimeEnv.channelId,
          driverBotId: driverBotUserId,
          sutAccountId,
          sutBotToken: runtimeEnv.sutBotToken,
          sutAppToken: runtimeEnv.sutAppToken,
        }),
    });
    try {
      await waitForSlackChannelRunning(gatewayHarness.gateway, sutAccountId);
      assertLeaseHealthy();
      for (const scenario of scenarios) {
        assertLeaseHealthy();
        const scenarioRun = scenario.buildRun(sutBotUserId);
        try {
          const requestStartedAtMs = Date.now();
          const sent = await sendSlackMessage(
            runtimeEnv.driverBotToken,
            runtimeEnv.channelId,
            scenarioRun.input,
          );
          const requestStartedAt = new Date(requestStartedAtMs).toISOString();
          const matched = await waitForSlackMessage({
            token: runtimeEnv.driverBotToken,
            channelId: runtimeEnv.channelId,
            afterTs: sent.messageTs,
            timeoutMs: scenario.timeoutMs,
            observedMessages,
            observationScenarioId: scenario.id,
            observationScenarioTitle: scenario.title,
            predicate: (message) =>
              matchesSlackScenarioReply({
                channelId: runtimeEnv.channelId,
                matchText: scenarioRun.matchText,
                message,
                sutBotUserId,
              }),
          });
          if (!scenarioRun.expectReply) {
            throw new Error(`unexpected reply message ${matched.message.messageTs} matched`);
          }
          assertSlackScenarioReply({
            expectedTextIncludes: scenarioRun.expectedTextIncludes,
            message: matched.message,
          });
          const rttMs = matched.observedAtMs - requestStartedAtMs;
          scenarioResults.push({
            id: scenario.id,
            title: scenario.title,
            status: "pass",
            details: redactPublicMetadata
              ? `reply matched in ${rttMs}ms`
              : `reply message ${matched.message.messageTs} matched in ${rttMs}ms`,
            rttMs,
            requestStartedAt,
            responseObservedAt: new Date(matched.observedAtMs).toISOString(),
            sentMessageTs: redactPublicMetadata ? undefined : sent.messageTs,
            responseMessageTs: redactPublicMetadata ? undefined : matched.message.messageTs,
          });
        } catch (error) {
          if (!scenarioRun.expectReply) {
            const details = formatErrorMessage(error);
            if (details === `timed out after ${scenario.timeoutMs}ms waiting for Slack message`) {
              scenarioResults.push({
                id: scenario.id,
                title: scenario.title,
                status: "pass",
                details: "no reply",
              });
              continue;
            }
          }
          scenarioResults.push({
            id: scenario.id,
            title: scenario.title,
            status: "fail",
            details: formatErrorMessage(error),
          });
        }
        assertLeaseHealthy();
      }
    } finally {
      try {
        const shouldPreserveGatewayDebugArtifacts = scenarioResults.some(
          (scenario) => scenario.status === "fail",
        );
        await gatewayHarness.stop(
          shouldPreserveGatewayDebugArtifacts ? { preserveToDir: gatewayDebugDirPath } : undefined,
        );
        preservedGatewayDebugArtifacts = shouldPreserveGatewayDebugArtifacts;
      } catch (error) {
        appendLiveLaneIssue(cleanupIssues, "live gateway cleanup", error);
      }
    }
  } finally {
    await leaseHeartbeat.stop();
    try {
      await credentialLease.release();
    } catch (error) {
      appendLiveLaneIssue(cleanupIssues, "credential lease release", error);
    }
  }

  const finishedAt = new Date().toISOString();
  const publishedCleanupIssues = redactPublicMetadata
    ? cleanupIssues.map(() => "details redacted (OPENCLAW_QA_REDACT_PUBLIC_METADATA=1)")
    : cleanupIssues;
  const passedCount = scenarioResults.filter((entry) => entry.status === "pass").length;
  const failedCount = scenarioResults.filter((entry) => entry.status === "fail").length;
  const summary: SlackQaSummary = {
    credentials: {
      source: credentialLease.source,
      kind: credentialLease.kind,
      role: credentialLease.role,
      ownerId: redactPublicMetadata ? undefined : credentialLease.ownerId,
      credentialId: redactPublicMetadata ? undefined : credentialLease.credentialId,
    },
    channelId: redactPublicMetadata ? "<redacted>" : runtimeEnv.channelId,
    startedAt,
    finishedAt,
    cleanupIssues: publishedCleanupIssues,
    counts: {
      total: scenarioResults.length,
      passed: passedCount,
      failed: failedCount,
    },
    scenarios: scenarioResults,
  };
  const reportPath = path.join(outputDir, "slack-qa-report.md");
  const summaryPath = path.join(outputDir, "slack-qa-summary.json");
  const observedMessagesPath = path.join(outputDir, "slack-qa-observed-messages.json");
  await fs.writeFile(
    reportPath,
    `${renderSlackQaMarkdown({
      cleanupIssues: publishedCleanupIssues,
      credentialSource: credentialLease.source,
      redactMetadata: redactPublicMetadata,
      channelId: redactPublicMetadata ? "<redacted>" : runtimeEnv.channelId,
      gatewayDebugDirPath: preservedGatewayDebugArtifacts ? gatewayDebugDirPath : undefined,
      startedAt,
      finishedAt,
      scenarios: scenarioResults,
    })}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  await fs.writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await fs.writeFile(
    observedMessagesPath,
    `${JSON.stringify(
      buildObservedMessagesArtifact({
        observedMessages,
        includeContent: includeObservedMessageContent,
        redactMetadata: redactPublicMetadata,
      }),
      null,
      2,
    )}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  const artifactPaths = {
    report: reportPath,
    summary: summaryPath,
    observedMessages: observedMessagesPath,
    ...(preservedGatewayDebugArtifacts ? { gatewayDebug: gatewayDebugDirPath } : {}),
  };
  if (cleanupIssues.length > 0) {
    throw new Error(
      buildLiveLaneArtifactsError({
        heading: "Slack QA cleanup failed after artifacts were written.",
        details: publishedCleanupIssues,
        artifacts: artifactPaths,
      }),
    );
  }

  return {
    outputDir,
    reportPath,
    summaryPath,
    observedMessagesPath,
    ...(preservedGatewayDebugArtifacts ? { gatewayDebugDirPath } : {}),
    scenarios: scenarioResults,
  };
}

export const __testing = {
  SLACK_QA_SCENARIOS,
  SLACK_QA_STANDARD_SCENARIO_IDS,
  buildObservedMessagesArtifact,
  buildSlackQaConfig,
  findScenario,
  matchesSlackScenarioReply,
  normalizeSlackObservedMessage,
  parseSlackQaCredentialPayload,
  resolveSlackQaRuntimeEnv,
  renderSlackQaMarkdown,
};
