// Vitest agents embedded agent config wires the agents embedded agent test shard.
import {
  agentsEmbeddedIncompleteTurnTestFiles,
  agentsEmbeddedOverflowCompactionTestFiles,
  agentsEmbeddedTestPatterns,
} from "./vitest.agents-paths.mjs";
import { createScopedVitestConfig } from "./vitest.scoped-config.ts";

export function createAgentsEmbeddedVitestConfig(env?: Record<string, string | undefined>) {
  return createScopedVitestConfig(agentsEmbeddedTestPatterns, {
    dir: "src/agents",
    env,
    exclude: [
      ...agentsEmbeddedIncompleteTurnTestFiles,
      ...agentsEmbeddedOverflowCompactionTestFiles,
    ],
    fileParallelism: false,
    name: "agents-embedded-agent",
  });
}

export default createAgentsEmbeddedVitestConfig();
