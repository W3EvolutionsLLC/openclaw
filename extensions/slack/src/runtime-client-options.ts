// Slack plugin module stores process-local runtime client overrides.
import type { WebClientOptions } from "@slack/web-api";

export type SlackRuntimeClientOptions = Pick<WebClientOptions, "slackApiUrl">;

type SlackRuntimeClientOptionsState = {
  options: SlackRuntimeClientOptions;
};

const SLACK_RUNTIME_CLIENT_OPTIONS_KEY = Symbol.for("openclaw.slack.runtimeClientOptions");

function getSlackRuntimeClientOptionsState(): SlackRuntimeClientOptionsState {
  const globalState = globalThis as typeof globalThis & {
    [SLACK_RUNTIME_CLIENT_OPTIONS_KEY]?: SlackRuntimeClientOptionsState;
  };
  const existing = globalState[SLACK_RUNTIME_CLIENT_OPTIONS_KEY];
  if (existing) {
    return existing;
  }
  const created: SlackRuntimeClientOptionsState = { options: {} };
  globalState[SLACK_RUNTIME_CLIENT_OPTIONS_KEY] = created;
  return created;
}

export function setSlackRuntimeClientOptions(options?: SlackRuntimeClientOptions): void {
  const slackApiUrl = options?.slackApiUrl?.trim();
  getSlackRuntimeClientOptionsState().options = slackApiUrl ? { slackApiUrl } : {};
}

export function getSlackRuntimeClientOptions(): SlackRuntimeClientOptions {
  return { ...getSlackRuntimeClientOptionsState().options };
}
