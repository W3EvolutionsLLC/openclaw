import { expect, it } from "vitest";
import {
  captureUiProof,
  createSessionManagementE2eSuite,
  installMockGateway,
  requireRecord,
  sessionRow,
  sessionsListResponse,
} from "./session-management.test-support.ts";

const suite = createSessionManagementE2eSuite(true);

const partialOperation = {
  id: "operation-one",
  requestId: "bulk-request-one",
  kind: "bulk-message",
  status: "needs_attention",
  messagePreview: "Please report your current blocker.",
  message: "Please report your current blocker.",
  targetCount: 2,
  counts: { pending: 0, accepted: 1, failed: 1 },
  createdAt: Date.parse("2026-08-22T03:00:00Z"),
  endedAt: Date.parse("2026-08-22T03:00:02Z"),
  targets: [
    {
      key: "agent:main:idle",
      expectedSessionId: "session-idle",
      status: "accepted",
      runId: "run-idle",
    },
    {
      key: "agent:main:busy",
      expectedSessionId: "session-busy",
      status: "failed",
      error: { code: "UNAVAILABLE", message: "session transcript is rebuilding" },
    },
  ],
} as const;

const retryOperation = {
  id: "operation-two",
  requestId: "bulk-request-two",
  retryOf: partialOperation.id,
  kind: "bulk-message",
  status: "completed",
  messagePreview: partialOperation.messagePreview,
  message: partialOperation.message,
  targetCount: 1,
  counts: { pending: 0, accepted: 1, failed: 0 },
  createdAt: Date.parse("2026-08-22T03:01:00Z"),
  endedAt: Date.parse("2026-08-22T03:01:01Z"),
  targets: [
    {
      key: "agent:main:busy",
      expectedSessionId: "session-busy",
      status: "accepted",
      runId: "run-busy-retry",
    },
  ],
} as const;

const resolvedOriginal = {
  ...partialOperation,
  status: "completed" as const,
  counts: { pending: 0, accepted: 2, failed: 0 },
  targets: [partialOperation.targets[0], retryOperation.targets[0]],
};

suite.define(() => {
  it("reviews a frozen audience and recovers a partial bulk-message operation", async () => {
    const context = await suite.browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 1000, width: 1600 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      methodResponses: {
        "sessions.list": sessionsListResponse([
          sessionRow("agent:main:idle", "Idle session", Date.parse("2026-08-22T02:59:00Z"), {
            sessionId: "session-idle",
          }),
          sessionRow("agent:main:busy", "Busy session", Date.parse("2026-08-22T02:58:00Z"), {
            sessionId: "session-busy",
            hasActiveRun: true,
            status: "running",
          }),
        ]),
        "sessions.operations.create": { operation: partialOperation },
        "sessions.operations.list": {
          sequence: [
            { operations: [partialOperation] },
            { operations: [partialOperation] },
            { operations: [retryOperation, resolvedOriginal] },
          ],
        },
        "sessions.operations.get": {
          sequence: [{ operation: partialOperation }, { operation: resolvedOriginal }],
        },
        "sessions.operations.retry": { operation: retryOperation },
      },
      sessionKey: "agent:main:main",
    });

    try {
      await page.goto(`${suite.server.baseUrl}sessions`);
      await page.locator(".sessions-toolbar").waitFor({ state: "visible" });
      await captureUiProof(page, "sessions-after-roster.png");
      await page.getByRole("button", { name: "Filters" }).click();
      await page.locator(".sessions-filter-popover__panel").waitFor({ state: "visible" });
      await captureUiProof(page, "sessions-after-filters.png");
      await page.keyboard.press("Escape");
      await page.getByRole("checkbox", { name: "Select session: agent:main:idle" }).check();
      await page.getByRole("checkbox", { name: "Select session: agent:main:busy" }).check();
      await captureUiProof(page, "sessions-bulk-selection.png");

      await page.getByRole("button", { name: "Send message" }).click();
      await expect.poll(() => page.getByText("Audience").count()).toBe(1);
      expect(
        (await page.locator(".sessions-bulk-review__summary").textContent())
          ?.replaceAll(/\s+/g, " ")
          .trim(),
      ).toContain("Busy sessions 1");
      await page.getByRole("textbox", { name: "Message" }).fill(partialOperation.message);
      await captureUiProof(page, "sessions-bulk-review.png");
      await page.getByRole("button", { name: "Start operation" }).click();

      const create = await gateway.waitForRequest("sessions.operations.create");
      expect(requireRecord(create.params)).toMatchObject({
        message: partialOperation.message,
        requestId: expect.any(String),
        targets: [
          { key: "agent:main:idle", expectedSessionId: "session-idle" },
          { key: "agent:main:busy", expectedSessionId: "session-busy" },
        ],
      });
      await page.getByText("Needs attention").waitFor({ state: "visible" });
      await captureUiProof(page, "sessions-operations-partial.png");

      await page.reload({ waitUntil: "networkidle" });
      await page.getByText("Needs attention").waitFor({ state: "visible" });
      await page.getByRole("button", { name: "View" }).click();
      await page.getByText("session transcript is rebuilding").waitFor({ state: "visible" });
      await page.getByRole("button", { name: "Retry 1" }).click();
      const retry = await gateway.waitForRequest("sessions.operations.retry");
      expect(requireRecord(retry.params)).toMatchObject({
        id: partialOperation.id,
        requestId: expect.any(String),
      });
      await expect
        .poll(async () => (await gateway.getRequests("sessions.operations.list")).length)
        .toBe(1);
      await expect
        .poll(async () => (await gateway.getRequests("sessions.operations.get")).length)
        .toBe(2);
      await page.getByText("Completed").first().waitFor({ state: "visible" });
      await captureUiProof(page, "sessions-operations-retry-complete.png");
    } finally {
      await context.close();
    }
  });
});
