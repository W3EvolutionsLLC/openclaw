import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import { describe, expect, it } from "vitest";
import {
  LIVE_TRANSPORT_BASELINE_STANDARD_SCENARIO_IDS,
  findMissingLiveTransportStandardScenarios,
} from "../shared/live-transport-scenarios.js";
import { __testing } from "./slack-live.runtime.js";

describe("slack live qa runtime", () => {
  it("resolves required Slack QA env vars", () => {
    expect(
      __testing.resolveSlackQaRuntimeEnv({
        OPENCLAW_QA_SLACK_CHANNEL_ID: "C123ABC",
        OPENCLAW_QA_SLACK_DRIVER_BOT_TOKEN: "driver",
        OPENCLAW_QA_SLACK_SUT_BOT_TOKEN: "sut",
        OPENCLAW_QA_SLACK_SUT_APP_TOKEN: "app",
      }),
    ).toEqual({
      channelId: "C123ABC",
      driverBotToken: "driver",
      sutBotToken: "sut",
      sutAppToken: "app",
    });
  });

  it("fails when a required Slack QA env var is missing", () => {
    expect(() =>
      __testing.resolveSlackQaRuntimeEnv({
        OPENCLAW_QA_SLACK_CHANNEL_ID: "C123ABC",
        OPENCLAW_QA_SLACK_DRIVER_BOT_TOKEN: "driver",
        OPENCLAW_QA_SLACK_SUT_BOT_TOKEN: "sut",
      }),
    ).toThrow("OPENCLAW_QA_SLACK_SUT_APP_TOKEN");
  });

  it("fails when the Slack channel id is malformed", () => {
    expect(() =>
      __testing.resolveSlackQaRuntimeEnv({
        OPENCLAW_QA_SLACK_CHANNEL_ID: "general",
        OPENCLAW_QA_SLACK_DRIVER_BOT_TOKEN: "driver",
        OPENCLAW_QA_SLACK_SUT_BOT_TOKEN: "sut",
        OPENCLAW_QA_SLACK_SUT_APP_TOKEN: "app",
      }),
    ).toThrow("OPENCLAW_QA_SLACK_CHANNEL_ID must be a Slack channel id");
  });

  it("parses Slack pooled credential payloads", () => {
    expect(
      __testing.parseSlackQaCredentialPayload({
        channelId: "G123ABC",
        driverBotToken: "driver",
        sutBotToken: "sut",
        sutAppToken: "app",
      }),
    ).toEqual({
      channelId: "G123ABC",
      driverBotToken: "driver",
      sutBotToken: "sut",
      sutAppToken: "app",
    });
  });

  it("injects a temporary Slack account into the QA gateway config", () => {
    const baseCfg: OpenClawConfig = {
      plugins: {
        allow: ["memory-core", "qa-channel"],
        entries: {
          "memory-core": { enabled: true },
          "qa-channel": { enabled: true },
        },
      },
      channels: {
        "qa-channel": {
          enabled: true,
          baseUrl: "http://127.0.0.1:43123",
          botUserId: "openclaw",
          botDisplayName: "OpenClaw QA",
          allowFrom: ["*"],
        },
      },
    };

    const next = __testing.buildSlackQaConfig(baseCfg, {
      channelId: "C123ABC",
      driverBotId: "U123",
      sutAccountId: "sut",
      sutBotToken: "xoxb-sut",
      sutAppToken: "xapp-sut",
    });

    expect(next.agents?.defaults?.skipBootstrap).toBe(true);
    expect(next.plugins?.allow).toContain("slack");
    expect(next.plugins?.entries?.slack).toEqual({ enabled: true });
    expect(next.messages?.groupChat?.visibleReplies).toBe("automatic");
    expect(next.channels?.slack).toEqual({
      enabled: true,
      defaultAccount: "sut",
      groupPolicy: "allowlist",
      requireMention: true,
      allowBots: true,
      accounts: {
        sut: {
          enabled: true,
          mode: "socket",
          botToken: "xoxb-sut",
          appToken: "xapp-sut",
          dmPolicy: "disabled",
          groupPolicy: "allowlist",
          requireMention: true,
          allowBots: true,
          channels: {
            C123ABC: {
              enabled: true,
              requireMention: true,
              allowBots: true,
              users: ["U123"],
            },
          },
        },
      },
    });
  });

  it("normalizes observed Slack messages", () => {
    expect(
      __testing.normalizeSlackObservedMessage({
        channelId: "C123ABC",
        observedAt: "2026-05-03T12:00:00.000Z",
        message: {
          bot_id: "B123",
          text: "hello",
          thread_ts: "1710000000.000000",
          ts: "1710000001.000000",
          user: "U123",
        },
      }),
    ).toEqual({
      channelId: "C123ABC",
      messageTs: "1710000001.000000",
      observedAt: "2026-05-03T12:00:00.000Z",
      senderBotId: "B123",
      senderId: "U123",
      senderIsBot: true,
      text: "hello",
      threadTs: "1710000000.000000",
    });
  });

  it("matches Slack scenario replies by channel, SUT id, and marker", () => {
    expect(
      __testing.matchesSlackScenarioReply({
        channelId: "C123ABC",
        sutBotUserId: "U999",
        matchText: "MARKER",
        message: {
          channelId: "C123ABC",
          messageTs: "1710000001.000000",
          observedAt: "2026-05-03T12:00:00.000Z",
          senderId: "U999",
          senderIsBot: true,
          text: "ack MARKER",
        },
      }),
    ).toBe(true);
  });

  it("redacts observed Slack metadata unless content capture is enabled", () => {
    expect(
      __testing.buildObservedMessagesArtifact({
        includeContent: false,
        redactMetadata: true,
        observedMessages: [
          {
            channelId: "C123ABC",
            messageTs: "1710000001.000000",
            observedAt: "2026-05-03T12:00:00.000Z",
            senderId: "U123",
            senderIsBot: true,
            text: "secret",
            scenarioId: "slack-canary",
            scenarioTitle: "Slack canary echo",
            matchedScenario: true,
          },
        ],
      }),
    ).toEqual([
      {
        scenarioId: "slack-canary",
        scenarioTitle: "Slack canary echo",
        matchedScenario: true,
        senderIsBot: true,
      },
    ]);
  });

  it("tracks Slack live coverage against the shared transport contract", () => {
    expect(__testing.SLACK_QA_STANDARD_SCENARIO_IDS).toEqual(["canary", "mention-gating"]);
    expect(
      findMissingLiveTransportStandardScenarios({
        coveredStandardScenarioIds: __testing.SLACK_QA_STANDARD_SCENARIO_IDS,
        expectedStandardScenarioIds: LIVE_TRANSPORT_BASELINE_STANDARD_SCENARIO_IDS,
      }),
    ).toEqual(["allowlist-block", "top-level-reply-shape", "restart-resume"]);
  });

  it("selects requested Slack scenarios", () => {
    expect(__testing.findScenario(["slack-canary"]).map((scenario) => scenario.id)).toEqual([
      "slack-canary",
    ]);
  });
});
