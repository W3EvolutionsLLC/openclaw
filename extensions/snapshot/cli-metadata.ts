// Snapshot plugin CLI metadata entrypoint.
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

export default definePluginEntry({
  id: "snapshot",
  name: "Snapshot",
  description: "Creates and verifies SQLite-safe OpenClaw state snapshots.",
  register(api) {
    api.registerCli(
      async ({ program }) => {
        const { registerSnapshotCli } = await import("./src/cli.js");
        registerSnapshotCli(program);
      },
      {
        descriptors: [
          {
            name: "snapshot",
            description: "Create, verify, list, and restore SQLite snapshots",
            hasSubcommands: true,
          },
        ],
      },
    );
  },
});
