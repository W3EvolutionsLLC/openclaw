import { expect, it } from "vitest";
import {
  createNewSessionPageE2eSuite,
  installMockGateway,
  pollLocatorText,
} from "./new-session-page.test-support.ts";

const suite = createNewSessionPageE2eSuite();

function skill(name: string) {
  return {
    name,
    textAliases: [`/${name}`],
    description: `${name} description`,
    source: "skill",
    scope: "text",
    acceptsArgs: false,
    skillModelVisible: true,
  };
}

suite.define(() => {
  it("switches the visible skill catalog with the selected agent", async () => {
    const context = await suite.browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1440 },
    });
    const page = await context.newPage();
    const consoleErrors: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error") {
        consoleErrors.push(message.text());
      }
    });
    page.on("pageerror", (error) => consoleErrors.push(error.message));
    const gateway = await installMockGateway(page, {
      defaultAgentId: "main",
      deferredMethods: ["chat.metadata"],
      methodResponses: {
        "agents.list": {
          agents: [
            { id: "main", workspace: "/tmp/main" },
            { id: "research", workspace: "/tmp/research" },
          ],
          defaultId: "main",
          mainKey: "main",
          scope: "agent",
        },
        "chat.metadata": {
          cases: [
            { match: { agentId: "main" }, response: { commands: [skill("main_skill")] } },
            {
              match: { agentId: "research" },
              response: { commands: [skill("research_skill")] },
            },
          ],
        },
        "commands.list": {
          commands: [skill("remote_skill")],
        },
      },
    });

    try {
      await page.goto(`${suite.server.baseUrl}new?agent=main`);
      await gateway.waitForRequest("chat.metadata");

      const message = page.locator(".new-session-page__message");
      await message.fill("$");
      await pollLocatorText(page.locator(".skill-menu")).toContain("Loading skills");
      expect(await page.locator(".skill-menu").textContent()).not.toContain("remote_skill");
      await gateway.resolveDeferred("chat.metadata", {
        commands: [skill("main_skill")],
      });
      await pollLocatorText(page.locator(".skill-menu")).toContain("main_skill");
      expect(await page.locator(".skill-menu").textContent()).not.toContain("remote_skill");
      await message.fill("");

      const picker = page.locator(".new-session-page__select--agent openclaw-agent-select");
      await picker.locator(".agent-select__trigger").click();
      await picker.getByRole("menuitemradio", { name: "research", exact: true }).click();
      await pollLocatorText(picker.locator(".agent-select__label")).toBe("research");

      await message.fill("$");
      await pollLocatorText(page.locator(".skill-menu")).toContain("research_skill");
      expect(await page.locator(".skill-menu").textContent()).not.toContain("main_skill");
      expect(consoleErrors).toEqual([]);
    } finally {
      await context.close();
    }
  });
});
