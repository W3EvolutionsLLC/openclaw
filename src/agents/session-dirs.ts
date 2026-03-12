import type { Dirent } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

export async function resolveAgentSessionDirsFromAgentsDir(agentsDir: string): Promise<string[]> {
  let entries: Dirent[] = [];
  try {
    entries = await fs.readdir(agentsDir, { withFileTypes: true });
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "ENOENT") {
      return [];
    }
    throw err;
  }

  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(agentsDir, entry.name, "sessions"))
    .toSorted((a, b) => a.localeCompare(b));
}

export async function resolveAgentSessionDirs(stateDir: string): Promise<string[]> {
  return await resolveAgentSessionDirsFromAgentsDir(path.join(stateDir, "agents"));
}
