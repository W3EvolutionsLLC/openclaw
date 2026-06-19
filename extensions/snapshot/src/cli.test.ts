import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  registerSnapshotCli,
  snapshotCreateCommand,
  snapshotListCommand,
  snapshotRestoreCommand,
  snapshotVerifyCommand,
  type SnapshotCommandRuntime,
} from "./cli.js";

let workspaceDir: string;

describe("snapshot cli", () => {
  beforeEach(async () => {
    workspaceDir = await fs.mkdtemp(path.join(tmpdir(), "snapshot-cli-"));
  });

  afterEach(async () => {
    await fs.rm(workspaceDir, { recursive: true, force: true });
  });

  it("registers the snapshot command group", () => {
    const program = new Command();

    registerSnapshotCli(program);

    const snapshot = program.commands.find((command) => command.name() === "snapshot");
    expect(snapshot?.commands.map((command) => command.name()).toSorted()).toEqual([
      "create",
      "list",
      "restore",
      "verify",
    ]);
  });

  it("creates, lists, verifies, and restores a SQLite snapshot", async () => {
    const runtime = createRuntimeCapture();
    const dbPath = path.join(workspaceDir, "source.sqlite");
    const repositoryPath = path.join(workspaceDir, "snapshots");
    const restorePath = path.join(workspaceDir, "restore", "source.sqlite");
    const db = new DatabaseSync(dbPath);
    try {
      db.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA user_version = 12;
        CREATE TABLE entries (value TEXT NOT NULL);
        INSERT INTO entries (value) VALUES ('from-cli');
      `);
    } finally {
      db.close();
    }

    await expect(
      snapshotCreateCommand(
        {
          db: dbPath,
          repository: repositoryPath,
          id: "cli-db",
          kind: "test",
          json: true,
        },
        runtime,
      ),
    ).resolves.toBe(0);
    const createReport = JSON.parse(runtime.stdout.shift() ?? "{}") as {
      snapshotPath?: string;
      manifest?: { database?: { id?: string; kind?: string; userVersion?: number } };
    };
    expect(createReport.snapshotPath).toBeTruthy();
    expect(createReport.manifest?.database).toMatchObject({
      id: "cli-db",
      kind: "test",
      userVersion: 12,
    });

    await expect(
      snapshotListCommand({ repository: repositoryPath, json: true }, runtime),
    ).resolves.toBe(0);
    const listReport = JSON.parse(runtime.stdout.shift() ?? "{}") as {
      snapshots?: unknown[];
    };
    expect(listReport.snapshots).toHaveLength(1);

    await expect(
      snapshotVerifyCommand(createReport.snapshotPath ?? "", { json: true }, runtime),
    ).resolves.toBe(0);
    const verifyReport = JSON.parse(runtime.stdout.shift() ?? "{}") as {
      ok?: boolean;
      integrityCheck?: string[];
    };
    expect(verifyReport).toMatchObject({ ok: true, integrityCheck: ["ok"] });

    await expect(
      snapshotRestoreCommand(
        createReport.snapshotPath ?? "",
        { target: restorePath, json: true },
        runtime,
      ),
    ).resolves.toBe(0);
    const restoreReport = JSON.parse(runtime.stdout.shift() ?? "{}") as {
      ok?: boolean;
      targetPath?: string;
    };
    expect(restoreReport).toMatchObject({ ok: true, targetPath: restorePath });
    expect(runtime.stderr).toEqual([]);

    const restored = new DatabaseSync(restorePath, { readOnly: true });
    try {
      expect(restored.prepare("SELECT value FROM entries").all()).toEqual([{ value: "from-cli" }]);
    } finally {
      restored.close();
    }
  });

  it("returns command usage errors without throwing", async () => {
    const runtime = createRuntimeCapture();

    await expect(snapshotCreateCommand({ repository: workspaceDir }, runtime)).resolves.toBe(2);

    expect(runtime.stdout).toEqual([]);
    expect(runtime.stderr).toEqual(["Missing required --db value."]);
  });
});

function createRuntimeCapture(): SnapshotCommandRuntime & {
  readonly stdout: string[];
  readonly stderr: string[];
} {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    writeStdout(value) {
      stdout.push(value.trimEnd());
    },
    error(value) {
      stderr.push(value);
    },
  };
}
