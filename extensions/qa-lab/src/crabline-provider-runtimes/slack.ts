// Qa Lab plugin module implements Slack fake-provider runtime setup.
import { createDefaultFakeProviderRuntime } from "./shared.js";

export const QA_LAB_SLACK_API_URL_ENV = "OPENCLAW_QA_LAB_SLACK_API_URL";

export const SLACK_FAKE_PROVIDER_RUNTIME = createDefaultFakeProviderRuntime("slack", {
  mapRuntimeEnv(env) {
    const { SLACK_API_URL, ...rest } = env;
    const slackApiUrl = SLACK_API_URL?.trim();
    return {
      ...rest,
      ...(slackApiUrl ? { [QA_LAB_SLACK_API_URL_ENV]: slackApiUrl } : {}),
    };
  },
});
