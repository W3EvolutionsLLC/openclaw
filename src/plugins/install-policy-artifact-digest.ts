import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { sha256File } from "../infra/crypto-digest.js";
import { isPathInside } from "../security/scan-paths.js";

const MAX_DIGEST_ENTRIES = 100_000;
const MAX_DIGEST_BYTES = 1024 * 1024 * 1024;

type DigestState = {
  allowExternalSymlink?: (params: {
    relativePath: string;
    resolvedTargetPath: string;
  }) => boolean | Promise<boolean>;
  bytes: number;
  entries: number;
  hash: ReturnType<typeof createHash>;
  rootRealPath: string;
};

function updateDigest(state: DigestState, value: unknown): void {
  state.hash.update(JSON.stringify(value));
  state.hash.update("\n");
}

function portablePath(value: string): string {
  return value.split(path.sep).join("/") || ".";
}

async function digestEntry(state: DigestState, absolutePath: string, relativePath: string) {
  state.entries += 1;
  if (state.entries > MAX_DIGEST_ENTRIES) {
    throw new Error(`install policy artifact digest exceeded ${MAX_DIGEST_ENTRIES} entries`);
  }
  const before = await fs.lstat(absolutePath);
  const relative = portablePath(relativePath);
  if (before.isSymbolicLink()) {
    const [target, resolvedTarget] = await Promise.all([
      fs.readlink(absolutePath),
      fs.realpath(absolutePath),
    ]);
    const external =
      resolvedTarget !== state.rootRealPath && !isPathInside(state.rootRealPath, resolvedTarget);
    if (
      external &&
      !(await state.allowExternalSymlink?.({
        relativePath: relative,
        resolvedTargetPath: resolvedTarget,
      }))
    ) {
      throw new Error(`install policy artifact contains an external symlink at ${relative}`);
    }
    updateDigest(state, ["symlink", relative, target]);
    return;
  }
  if (before.isDirectory()) {
    updateDigest(state, ["directory", relative, before.mode & 0o777]);
    const entries = (await fs.readdir(absolutePath, { withFileTypes: true })).toSorted(
      (left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0),
    );
    for (const entry of entries) {
      await digestEntry(
        state,
        path.join(absolutePath, entry.name),
        path.join(relativePath, entry.name),
      );
    }
    return;
  }
  if (!before.isFile()) {
    throw new Error(`install policy artifact contains an unsupported entry at ${relative}`);
  }
  state.bytes += before.size;
  if (state.bytes > MAX_DIGEST_BYTES) {
    throw new Error(`install policy artifact digest exceeded ${MAX_DIGEST_BYTES} bytes`);
  }
  updateDigest(state, [
    "file",
    relative,
    before.mode & 0o777,
    before.size,
    await sha256File(absolutePath),
  ]);
}

/** Digests the staged bytes without binding the result to a transient extraction path. */
export async function digestInstallPolicyArtifact(params: {
  allowExternalSymlink?: DigestState["allowExternalSymlink"];
  sourcePath: string;
  sourcePathKind: "file" | "directory";
}): Promise<string> {
  const rootRealPath = await fs.realpath(params.sourcePath);
  const rootStat = await fs.stat(rootRealPath);
  if (
    (params.sourcePathKind === "file" && !rootStat.isFile()) ||
    (params.sourcePathKind === "directory" && !rootStat.isDirectory())
  ) {
    throw new Error(`install policy sourcePath is not a ${params.sourcePathKind}`);
  }
  const state: DigestState = {
    allowExternalSymlink: params.allowExternalSymlink,
    bytes: 0,
    entries: 0,
    hash: createHash("sha256"),
    rootRealPath,
  };
  await digestEntry(state, rootRealPath, "");
  return `sha256:${state.hash.digest("hex")}`;
}
