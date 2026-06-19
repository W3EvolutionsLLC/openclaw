// Snapshot plugin module implements CLI behavior.
import type { Command } from "commander";
import { createLocalSqliteSnapshotProvider } from "./local-repository.js";
import type {
  SnapshotManifest,
  SnapshotSummary,
  SnapshotVerificationResult,
} from "./snapshot-provider.js";

export type SnapshotCommandRuntime = {
  writeStdout(value: string): void;
  error(value: string): void;
};

export interface SnapshotCreateOptions {
  readonly db?: string;
  readonly repository?: string;
  readonly id?: string;
  readonly kind?: string;
  readonly json?: boolean;
}

export interface SnapshotRepositoryOptions {
  readonly repository?: string;
  readonly json?: boolean;
}

export interface SnapshotJsonOptions {
  readonly json?: boolean;
}

export interface SnapshotRestoreOptions extends SnapshotJsonOptions {
  readonly target?: string;
}

type SnapshotCreateReport = {
  readonly ok: true;
  readonly snapshotPath: string;
  readonly manifest: SnapshotManifest;
};

type SnapshotVerifyReport = SnapshotVerificationResult & {
  readonly snapshotPath: string;
};

type SnapshotRestoreReport = SnapshotVerificationResult & {
  readonly snapshotPath: string;
  readonly targetPath: string;
};

type SnapshotListReport = {
  readonly ok: true;
  readonly snapshots: readonly SnapshotSummary[];
};

const defaultRuntime: SnapshotCommandRuntime = {
  writeStdout(value) {
    process.stdout.write(value);
  },
  error(value) {
    process.stderr.write(`${value}\n`);
  },
};

export function registerSnapshotCli(program: Command): void {
  const snapshot = program
    .command("snapshot")
    .description("Create, verify, list, and restore SQLite snapshots")
    .action(() => {
      snapshot.outputHelp();
      process.exitCode = 1;
    });

  snapshot
    .command("create")
    .description("Create a consistent SQLite snapshot in a local repository")
    .requiredOption("--db <path>", "SQLite database path")
    .requiredOption("--repository <path>", "Snapshot repository directory")
    .option("--id <id>", "Logical database id recorded in the manifest")
    .option("--kind <kind>", "Logical database kind recorded in the manifest")
    .option("--json", "Emit JSON output")
    .action(async (options: SnapshotCreateOptions) => {
      process.exitCode = await snapshotCreateCommand(options);
    });

  snapshot
    .command("verify")
    .description("Verify a snapshot manifest, artifact hash, and SQLite integrity")
    .argument("<snapshot>", "Snapshot directory")
    .option("--json", "Emit JSON output")
    .action(async (snapshotPath: string, options: SnapshotJsonOptions) => {
      process.exitCode = await snapshotVerifyCommand(snapshotPath, options);
    });

  snapshot
    .command("restore")
    .description("Restore a verified snapshot to a new SQLite database path")
    .argument("<snapshot>", "Snapshot directory")
    .requiredOption("--target <path>", "Target SQLite database path; must not already exist")
    .option("--json", "Emit JSON output")
    .action(async (snapshotPath: string, options: SnapshotRestoreOptions) => {
      process.exitCode = await snapshotRestoreCommand(snapshotPath, options);
    });

  snapshot
    .command("list")
    .description("List snapshots in a local repository")
    .requiredOption("--repository <path>", "Snapshot repository directory")
    .option("--json", "Emit JSON output")
    .action(async (options: SnapshotRepositoryOptions) => {
      process.exitCode = await snapshotListCommand(options);
    });
}

export async function snapshotCreateCommand(
  options: SnapshotCreateOptions,
  runtime: SnapshotCommandRuntime = defaultRuntime,
): Promise<number> {
  try {
    const repositoryPath = requireOption(options.repository, "--repository");
    const dbPath = requireOption(options.db, "--db");
    const provider = createLocalSqliteSnapshotProvider({ repositoryPath });
    const result = await provider.create({
      path: dbPath,
      ...(options.id ? { id: options.id } : {}),
      ...(options.kind ? { kind: options.kind } : {}),
    });
    writeCreateReport(
      { ok: true, snapshotPath: result.ref.path, manifest: result.manifest },
      options,
      runtime,
    );
    return 0;
  } catch (err) {
    runtime.error(err instanceof Error ? err.message : String(err));
    return 2;
  }
}

export async function snapshotVerifyCommand(
  snapshotPath: string,
  options: SnapshotJsonOptions,
  runtime: SnapshotCommandRuntime = defaultRuntime,
): Promise<number> {
  try {
    const provider = createLocalSqliteSnapshotProvider({ repositoryPath: "." });
    const verified = await provider.verify({ path: requireValue(snapshotPath, "<snapshot>") });
    writeVerifyReport({ ...verified, snapshotPath }, options, runtime);
    return 0;
  } catch (err) {
    runtime.error(err instanceof Error ? err.message : String(err));
    return 2;
  }
}

export async function snapshotRestoreCommand(
  snapshotPath: string,
  options: SnapshotRestoreOptions,
  runtime: SnapshotCommandRuntime = defaultRuntime,
): Promise<number> {
  try {
    const targetPath = requireOption(options.target, "--target");
    const provider = createLocalSqliteSnapshotProvider({ repositoryPath: "." });
    const verified = await provider.restore(
      { path: requireValue(snapshotPath, "<snapshot>") },
      targetPath,
    );
    writeRestoreReport({ ...verified, snapshotPath, targetPath }, options, runtime);
    return 0;
  } catch (err) {
    runtime.error(err instanceof Error ? err.message : String(err));
    return 2;
  }
}

export async function snapshotListCommand(
  options: SnapshotRepositoryOptions,
  runtime: SnapshotCommandRuntime = defaultRuntime,
): Promise<number> {
  try {
    const provider = createLocalSqliteSnapshotProvider({
      repositoryPath: requireOption(options.repository, "--repository"),
    });
    writeListReport({ ok: true, snapshots: (await provider.list?.()) ?? [] }, options, runtime);
    return 0;
  } catch (err) {
    runtime.error(err instanceof Error ? err.message : String(err));
    return 2;
  }
}

function writeCreateReport(
  report: SnapshotCreateReport,
  options: SnapshotJsonOptions,
  runtime: SnapshotCommandRuntime,
): void {
  if (options.json === true) {
    writeJson(report, runtime);
    return;
  }
  runtime.writeStdout(
    `snapshot create: ${report.snapshotPath} (${report.manifest.database.id}, ${report.manifest.artifact.sizeBytes} bytes)\n`,
  );
}

function writeVerifyReport(
  report: SnapshotVerifyReport,
  options: SnapshotJsonOptions,
  runtime: SnapshotCommandRuntime,
): void {
  if (options.json === true) {
    writeJson(report, runtime);
    return;
  }
  runtime.writeStdout(
    `snapshot verify: ok (${report.manifest.database.id}, ${report.manifest.artifact.sizeBytes} bytes)\n`,
  );
}

function writeRestoreReport(
  report: SnapshotRestoreReport,
  options: SnapshotJsonOptions,
  runtime: SnapshotCommandRuntime,
): void {
  if (options.json === true) {
    writeJson(report, runtime);
    return;
  }
  runtime.writeStdout(`snapshot restore: ${report.targetPath} (${report.manifest.database.id})\n`);
}

function writeListReport(
  report: SnapshotListReport,
  options: SnapshotJsonOptions,
  runtime: SnapshotCommandRuntime,
): void {
  if (options.json === true) {
    writeJson(report, runtime);
    return;
  }
  if (report.snapshots.length === 0) {
    runtime.writeStdout("snapshot list: no snapshots\n");
    return;
  }
  for (const snapshot of report.snapshots) {
    runtime.writeStdout(
      `${snapshot.manifest.createdAt} ${snapshot.manifest.database.id} ${snapshot.ref.path}\n`,
    );
  }
}

function writeJson(value: unknown, runtime: SnapshotCommandRuntime): void {
  runtime.writeStdout(`${JSON.stringify(value)}\n`);
}

function requireOption(value: string | undefined, flag: string): string {
  return requireValue(value, flag);
}

function requireValue(value: string | undefined, label: string): string {
  if (value === undefined || value.trim() === "") {
    throw new Error(`Missing required ${label} value.`);
  }
  return value;
}
