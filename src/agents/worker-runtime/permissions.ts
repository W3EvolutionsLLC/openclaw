import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type AgentWorkerPermissionRoots = {
  workspaceDir: string;
  agentDir?: string;
  sessionFile?: string;
  readRoots?: string[];
  writeRoots?: string[];
};

function normalizeRoot(path: string | undefined): string | undefined {
  const trimmed = path?.trim();
  if (!trimmed) {
    return undefined;
  }
  return resolve(trimmed);
}

function addRoot(target: Set<string>, path: string | undefined): void {
  const normalized = normalizeRoot(path);
  if (normalized) {
    target.add(normalized);
  }
}

function addNodeModuleReadRoots(target: Set<string>): void {
  let current = dirname(fileURLToPath(import.meta.url));
  let previous = "";
  while (current !== previous) {
    addRoot(target, `${current}/node_modules/*`);
    previous = current;
    current = dirname(current);
  }
}

export function buildAgentWorkerPermissionExecArgv(roots: AgentWorkerPermissionRoots): string[] {
  const readRoots = new Set<string>();
  const writeRoots = new Set<string>();

  addRoot(readRoots, `${roots.workspaceDir}/*`);
  addRoot(writeRoots, `${roots.workspaceDir}/*`);

  addRoot(readRoots, roots.agentDir ? `${roots.agentDir}/*` : undefined);
  addRoot(writeRoots, roots.agentDir ? `${roots.agentDir}/*` : undefined);

  if (roots.sessionFile) {
    addRoot(readRoots, roots.sessionFile);
    addRoot(writeRoots, roots.sessionFile);
    addRoot(writeRoots, `${dirname(resolve(roots.sessionFile))}/*`);
  }

  for (const root of roots.readRoots ?? []) {
    addRoot(readRoots, root);
  }
  for (const root of roots.writeRoots ?? []) {
    addRoot(writeRoots, root);
  }

  addNodeModuleReadRoots(readRoots);

  const args = ["--permission"];
  for (const root of [...readRoots].toSorted()) {
    args.push(`--allow-fs-read=${root}`);
  }
  for (const root of [...writeRoots].toSorted()) {
    args.push(`--allow-fs-write=${root}`);
  }
  return args;
}
