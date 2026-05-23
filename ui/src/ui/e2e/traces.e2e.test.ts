import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  canRunPlaywrightChromium,
  installMockGateway,
  startControlUiE2eServer,
  type ControlUiE2eServer,
} from "../../test-helpers/control-ui-e2e.ts";

const chromiumExecutablePath = chromium.executablePath();
const chromiumAvailable = canRunPlaywrightChromium(chromiumExecutablePath);
const allowMissingChromium = process.env.OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM === "1";
const describeControlUiE2e = chromiumAvailable || !allowMissingChromium ? describe : describe.skip;

let browser: Browser;
let server: ControlUiE2eServer;

describeControlUiE2e("Control UI traces mocked Gateway E2E", () => {
  beforeAll(async () => {
    if (!chromiumAvailable) {
      throw new Error(
        `Playwright Chromium is not installed at ${chromiumExecutablePath}. Run \`pnpm --dir ui exec playwright install chromium\`, or set OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM=1 only when intentionally skipping this lane.`,
      );
    }
    server = await startControlUiE2eServer();
    browser = await chromium.launch();
  });

  afterAll(async () => {
    await browser?.close();
    await server?.close();
  });

  it("renders captured full prompt and tool payloads", async () => {
    const traceSummary = {
      callId: "run-trace:model:1",
      durationMs: 312,
      hasRequestPayload: true,
      hasResponseChunks: true,
      id: "run-trace:model:1",
      inputItemCount: 1,
      model: "gpt-5.5",
      provider: "openai",
      requestPayloadBytes: 2048,
      responseChunkCount: 1,
      responseStreamBytes: 128,
      runId: "run-trace",
      startedAt: "2026-05-22T09:00:00.000Z",
      status: "completed",
      timeToFirstByteMs: 90,
      toolCount: 1,
    };
    const requestPayload = {
      instructions: "You are a concise debugging assistant.",
      input: [
        {
          content: [{ text: "full prompt text visible in trace", type: "input_text" }],
          role: "user",
        },
        {
          arguments: '{"cmd":"echo trace"}',
          name: "shell_exec",
          type: "function_call",
        },
        {
          call_id: "call_shell_exec",
          output: "trace",
          type: "function_call_output",
        },
      ],
      model: "gpt-5.5",
      reasoning: { effort: "medium" },
      tools: [
        {
          description: "Run a shell command",
          name: "shell_exec",
          parameters: {
            properties: { cmd: { description: "Command to execute", type: "string" } },
            required: ["cmd"],
            type: "object",
          },
          type: "function",
        },
      ],
    };
    const context = await browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      methodResponses: {
        "traces.capabilities": {
          available: true,
          payloadCaptureEnabled: true,
          reasons: [],
          responseCaptureEnabled: true,
          sourceCheckout: true,
          store: "memory",
          uiEnabled: true,
        },
        "traces.get": {
          trace: {
            ...traceSummary,
            requestPayload,
            responseChunks: [
              { delta: "hidden reasoning", type: "thinking_delta" },
              { delta: '{"cmd":"hidden"}', type: "toolcall_delta" },
              { delta: "done", type: "response.output_text.delta" },
            ],
          },
        },
        "traces.list": { traces: [traceSummary] },
      },
    });

    try {
      await page.goto(`${server.baseUrl}traces`);
      await gateway.waitForRequest("traces.capabilities");
      await gateway.waitForRequest("traces.list");
      await gateway.waitForRequest("traces.get");

      await page.locator('.sidebar-nav .nav-item[title="Traces"]').waitFor();
      await page
        .locator(".traces-detail .card-title", { hasText: "openai/gpt-5.5" })
        .waitFor({ timeout: 10_000 });

      const rowText = await page.locator('[data-traces-row="run-trace:model:1"]').textContent();
      expect(rowText).toContain("openai/gpt-5.5");
      expect(rowText).toContain("312 ms");
      expect(rowText).toContain("1 tool");
      expect(rowText).not.toContain("2.0 KB");

      const promptText = await page.locator("[data-traces-request-payload]").textContent();
      const toolCallText = await page
        .locator(".trace-message.role-tool-call .trace-message-content")
        .textContent();
      const toolsText = await page.locator("[data-traces-tools]").textContent();
      const paramsText = await page.locator(".trace-param-list").textContent();
      const responseText = await page.locator(".trace-message-content.response").textContent();
      expect(promptText).toContain("You are a concise debugging assistant.");
      expect(promptText).toContain("full prompt text visible in trace");
      expect(promptText).toContain("instructions");
      expect(promptText).toContain("user");
      expect(promptText).toContain("shell_exec(");
      expect(promptText).toContain('"cmd": "echo trace"');
      expect(toolCallText).not.toContain('"{\\"cmd\\":');
      expect(toolsText).toContain("shell_exec");
      expect(toolsText).toContain("cmd");
      expect(toolsText).toContain("string, required");
      expect(paramsText).toContain("reasoning");
      await page.locator("summary", { hasText: "Raw parameters" }).waitFor();
      expect(responseText).toContain("done");
      expect(responseText).not.toContain("hidden reasoning");
      expect(responseText).not.toContain('{"cmd":"hidden"}');
    } finally {
      await context.close();
    }
  });

  it("hides the sidebar entry when tracing is not available", async () => {
    const context = await browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      methodResponses: {
        "traces.capabilities": {
          available: false,
          payloadCaptureEnabled: false,
          reasons: ["not_source_checkout", "env_flag_missing"],
          responseCaptureEnabled: false,
          sourceCheckout: false,
          store: "memory",
          uiEnabled: false,
        },
      },
    });

    try {
      await page.goto(`${server.baseUrl}chat`);
      await gateway.waitForRequest("traces.capabilities");
      expect(await page.locator('.sidebar-nav .nav-item[title="Traces"]').count()).toBe(0);
    } finally {
      await context.close();
    }
  });
});
