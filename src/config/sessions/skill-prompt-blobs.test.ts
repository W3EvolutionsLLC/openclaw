import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withTempDir } from "../../test-helpers/temp-dir.js";
import {
  ensureSessionStorePromptBlobsForPersistence,
  hydrateSessionStoreSkillPromptRefs,
  projectSessionStoreForPersistence,
} from "./skill-prompt-blobs.js";
import type { SessionEntry } from "./types.js";

function largePrompt(label: string): string {
  return `<available_skills>\n${`${label}\n`.repeat(200)}</available_skills>`;
}

describe("session skill prompt blobs", () => {
  it("externalizes and hydrates both prompt variants byte-exactly", async () => {
    await withTempDir({ prefix: "openclaw-skill-prompt-blobs-" }, async (dir) => {
      const storePath = path.join(dir, "sessions.json");
      const prompt = largePrompt("embedded");
      const catalogPrompt = largePrompt("codex");
      const projection = projectSessionStoreForPersistence({
        storePath,
        store: {
          session: {
            sessionId: "session",
            updatedAt: 1,
            skillsSnapshot: {
              prompt,
              catalogPrompt,
              promptFormatVersion: 4,
              skills: [{ name: "demo" }],
            },
          },
        },
      });

      const persistedSnapshot = projection.store.session?.skillsSnapshot;
      expect(persistedSnapshot?.prompt).toBeUndefined();
      expect(persistedSnapshot?.catalogPrompt).toBeUndefined();
      expect(persistedSnapshot?.promptRef).toBeDefined();
      expect(persistedSnapshot?.catalogPromptRef).toBeDefined();
      expect(projection.promptBlobs.size).toBe(2);

      await ensureSessionStorePromptBlobsForPersistence({
        storePath,
        promptBlobs: projection.promptBlobs.values(),
      });
      const hydratedStore: Record<string, unknown> = { ...projection.store };
      expect(hydrateSessionStoreSkillPromptRefs({ storePath, store: hydratedStore })).toBe(true);
      const hydrated = (hydratedStore.session as SessionEntry).skillsSnapshot;
      expect(hydrated?.prompt).toBe(prompt);
      expect(hydrated?.catalogPrompt).toBe(catalogPrompt);
      expect(hydrated?.promptRef).toBeUndefined();
      expect(hydrated?.catalogPromptRef).toBeUndefined();
    });
  });

  it("drops the snapshot when the referenced catalog blob is missing", async () => {
    await withTempDir({ prefix: "openclaw-skill-prompt-blobs-" }, async (dir) => {
      const storePath = path.join(dir, "sessions.json");
      const projection = projectSessionStoreForPersistence({
        storePath,
        store: {
          session: {
            sessionId: "session",
            updatedAt: 1,
            skillsSnapshot: {
              prompt: largePrompt("embedded"),
              catalogPrompt: largePrompt("codex"),
              promptFormatVersion: 4,
              skills: [{ name: "demo" }],
            },
          },
        },
      });
      await ensureSessionStorePromptBlobsForPersistence({
        storePath,
        promptBlobs: projection.promptBlobs.values(),
      });
      const catalogHash = projection.store.session?.skillsSnapshot?.catalogPromptRef?.hash;
      if (!catalogHash) {
        throw new Error("expected catalog prompt ref");
      }
      await fs.rm(
        path.join(dir, "skills-prompts", "sha256", catalogHash.slice(0, 2), `${catalogHash}.txt`),
      );

      const hydratedStore: Record<string, unknown> = { ...projection.store };
      expect(hydrateSessionStoreSkillPromptRefs({ storePath, store: hydratedStore })).toBe(true);
      expect((hydratedStore.session as SessionEntry).skillsSnapshot).toBeUndefined();
    });
  });
});
