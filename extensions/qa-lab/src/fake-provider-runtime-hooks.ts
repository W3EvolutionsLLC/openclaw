// QA Lab plugin module installs fake-provider runtime hooks for channel plugins.
import { createWhatsAppSocket } from "@openclaw/crabline/whatsapp-socket-factory";
import { setSlackRuntimeClientOptions } from "@openclaw/slack/api.js";
import {
  setWhatsAppMonitorRuntimeOptions,
  type WhatsAppCreateSocket,
  type WhatsAppSocket,
} from "@openclaw/whatsapp/api.js";
import { QA_LAB_SLACK_API_URL_ENV } from "./crabline-provider-runtimes/slack.js";

function hasWhatsAppFakeProviderEnv(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env.CRABLINE_WHATSAPP_API_ROOT?.trim());
}

const createFakeProviderWhatsAppSocket: WhatsAppCreateSocket = async (printQr, verbose) =>
  (await createWhatsAppSocket(printQr, verbose)) as WhatsAppSocket;

export function installFakeProviderRuntimeHooks(env: NodeJS.ProcessEnv = process.env): void {
  const slackApiUrl = env[QA_LAB_SLACK_API_URL_ENV]?.trim();
  if (slackApiUrl) {
    setSlackRuntimeClientOptions({ slackApiUrl });
  }
  if (hasWhatsAppFakeProviderEnv(env)) {
    setWhatsAppMonitorRuntimeOptions({ createSocket: createFakeProviderWhatsAppSocket });
  }
}
