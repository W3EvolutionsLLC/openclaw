// Qa Lab plugin module implements Slack fake-provider runtime setup.
import { QA_LAB_SLACK_API_URL_ENV } from "./env.js";
import { createDefaultFakeProviderRuntime } from "./shared.js";

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
