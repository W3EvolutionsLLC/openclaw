// QA Lab plugin module installs fake-provider runtime hooks for channel plugins.
import { createWhatsAppSocket } from "@openclaw/crabline/whatsapp-socket-factory";
import { setSlackRuntimeClientOptions } from "@openclaw/slack/qa-runtime-api.js";
import { setWhatsAppMonitorRuntimeOptions } from "@openclaw/whatsapp/qa-runtime-api.js";
import { QA_LAB_SLACK_API_URL_ENV } from "./crabline-provider-runtimes/slack.js";

type WhatsAppCreateSocket = NonNullable<
  NonNullable<Parameters<typeof setWhatsAppMonitorRuntimeOptions>[0]>["createSocket"]
>;

function hasWhatsAppFakeProviderEnv(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env.CRABLINE_WHATSAPP_API_ROOT?.trim());
}

const createFakeProviderWhatsAppSocket: WhatsAppCreateSocket = async (printQr, verbose, opts) =>
  (await createWhatsAppSocket(
    printQr,
    verbose,
    opts as Parameters<typeof createWhatsAppSocket>[2],
  )) as Awaited<ReturnType<WhatsAppCreateSocket>>;

export function installFakeProviderRuntimeHooks(env: NodeJS.ProcessEnv = process.env): void {
  const slackApiUrl = env[QA_LAB_SLACK_API_URL_ENV]?.trim();
  if (slackApiUrl) {
    setSlackRuntimeClientOptions({ slackApiUrl });
  }
  if (hasWhatsAppFakeProviderEnv(env)) {
    setWhatsAppMonitorRuntimeOptions({ createSocket: createFakeProviderWhatsAppSocket });
  }
}
