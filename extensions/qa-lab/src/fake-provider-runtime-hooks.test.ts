// QA Lab tests cover fake-provider runtime hook installation.
import { resolveSlackWebClientOptions, setSlackRuntimeClientOptions } from "@openclaw/slack/api.js";
import {
  getWhatsAppMonitorRuntimeOptions,
  setWhatsAppMonitorRuntimeOptions,
} from "@openclaw/whatsapp/qa-runtime-api.js";
import { beforeEach, describe, expect, it } from "vitest";
import { QA_LAB_SLACK_API_URL_ENV } from "./crabline-provider-runtimes/slack.js";
import { installFakeProviderRuntimeHooks } from "./fake-provider-runtime-hooks.js";

describe("installFakeProviderRuntimeHooks", () => {
  beforeEach(() => {
    setSlackRuntimeClientOptions();
    setWhatsAppMonitorRuntimeOptions();
  });

  it("registers Slack API roots from QA Lab env only", () => {
    installFakeProviderRuntimeHooks({
      [QA_LAB_SLACK_API_URL_ENV]: " http://127.0.0.1:49152/api/ ",
      OPENCLAW_SLACK_API_URL: "http://127.0.0.1:49153/api/",
    });

    expect(resolveSlackWebClientOptions().slackApiUrl).toBe("http://127.0.0.1:49152/api/");
  });

  it("registers the WhatsApp fake-provider socket when the fake provider env is present", () => {
    installFakeProviderRuntimeHooks({
      CRABLINE_WHATSAPP_API_ROOT: "http://127.0.0.1:49152/crabline/whatsapp",
    });

    expect(getWhatsAppMonitorRuntimeOptions().createSocket).toBeTypeOf("function");
  });

  it("leaves WhatsApp monitor options untouched without fake-provider env", () => {
    installFakeProviderRuntimeHooks({});

    expect(getWhatsAppMonitorRuntimeOptions()).toEqual({});
  });
});
