import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { WebSocket, WebSocketServer, type RawData } from "ws";

type CaseInput = {
  caseId: string;
  gateway: "baseline" | "candidate";
  node: "baseline" | "candidate";
  outcome: "passed" | "protocol-mismatch";
};
type Observation = {
  clientMin: number;
  clientMax: number;
  helloProtocol: number | null;
  identity: { clientId: string; mode: string; platform: string; role: string };
  protocolError: unknown;
};

const GATEWAY_PORT = 18789;
const OBSERVER_PORT = 18790;
const CANDIDATE_UID = 65532;
const CANDIDATE_GID = 65532;
const CLI_OUTPUT_LIMIT_BYTES = 1024 * 1024;
if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  await main();
}

async function main() {
  const inputPath = process.argv[2];
  const outputPath = process.argv[3];
  if (!inputPath || !outputPath) {
    throw new Error("usage: gateway-node-compat-case.ts <input.json> <output.json>");
  }
  const input = JSON.parse(readFileSync(inputPath, "utf8")) as CaseInput;
  const architecture = process.env.OPENCLAW_GATEWAY_NODE_ARCH;
  if ((architecture !== "arm64" && architecture !== "x64") || process.arch !== architecture) {
    throw new Error(`Container architecture ${process.arch} does not match ${architecture}.`);
  }
  const token = randomUUID().replaceAll("-", "");
  const children = new Set<ChildProcess>();
  const startedAt = new Date().toISOString();
  try {
    const gateway = runtime(input.gateway);
    const node = runtime(input.node);
    const gatewayEnv = runtimeEnv("gateway", gateway.binDir, token);
    const gatewayChild = start(
      gateway.cli,
      [
        "gateway",
        "run",
        "--bind",
        "loopback",
        "--port",
        String(GATEWAY_PORT),
        "--force",
        "--allow-unconfigured",
      ],
      gatewayEnv,
      children,
    );
    await waitForPort(GATEWAY_PORT, gatewayChild);

    const observer = await startObserver(`ws://127.0.0.1:${GATEWAY_PORT}`);
    try {
      let operation: unknown = null;
      if (input.outcome === "passed") {
        const startNode = () =>
          start(
            node.cli,
            [
              "node",
              "run",
              "--host",
              "127.0.0.1",
              "--port",
              String(OBSERVER_PORT),
              "--node-id",
              input.caseId,
              "--display-name",
              input.caseId,
            ],
            runtimeEnv("node", node.binDir, token),
            children,
          );
        operation = await approveAndInvoke({
          caseId: input.caseId,
          env: gatewayEnv,
          gateway,
          gatewayToken: token,
          nodeChild: startNode(),
          startNode,
        });
      } else {
        await runDisjointClient(node.packageRoot, token, children);
      }
      const observation = validateObservedIdentity(observer.read());
      const mismatch =
        input.outcome === "protocol-mismatch"
          ? normalizeMismatch(observation, input.gateway === "baseline" ? "2026.5.7" : undefined)
          : null;
      writeFileSync(
        outputPath,
        `${JSON.stringify({
          observation,
          operation,
          mismatch,
          architecture,
          startedAt,
          completedAt: new Date().toISOString(),
        })}\n`,
        { encoding: "utf8", mode: 0o644 },
      );
    } finally {
      await observer.close();
    }
  } finally {
    for (const child of children) {
      child.kill("SIGTERM");
    }
    await Promise.all([...children].map(waitForExit));
  }
}

function runtime(id: "baseline" | "candidate") {
  const prefix = `/runtimes/${id}`;
  return {
    binDir: join(prefix, "bin"),
    cli: join(prefix, "bin", "openclaw"),
    packageRoot: join(prefix, "lib", "node_modules", "openclaw"),
  };
}

function runtimeEnv(name: string, binDir: string, gatewayToken: string) {
  const home = `/tmp/${name}`;
  mkdirSync(home, { recursive: true, mode: 0o700 });
  chmodSync(home, 0o777);
  return {
    HOME: home,
    PATH: `${binDir}:${process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin"}`,
    OPENCLAW_CONFIG_PATH: join(home, "openclaw.json"),
    OPENCLAW_GATEWAY_TOKEN: gatewayToken,
    OPENCLAW_HOME: home,
    OPENCLAW_STATE_DIR: join(home, ".openclaw"),
  };
}

function start(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  children: Set<ChildProcess>,
) {
  const child = spawn(command, args, {
    env,
    stdio: ["ignore", "inherit", "inherit"],
    uid: CANDIDATE_UID,
    gid: CANDIDATE_GID,
  });
  children.add(child);
  child.once("close", () => children.delete(child));
  return child;
}

async function waitForPort(port: number, child: ChildProcess) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Gateway exited before opening port ${port}.`);
    }
    const connected = await new Promise<boolean>((resolvePromise) => {
      const socket = createConnection({ host: "127.0.0.1", port });
      socket.setTimeout(250);
      socket.once("connect", () => {
        socket.destroy();
        resolvePromise(true);
      });
      socket.once("timeout", () => {
        socket.destroy();
        resolvePromise(false);
      });
      socket.once("error", () => resolvePromise(false));
    });
    if (connected) {
      return;
    }
    await delay(100);
  }
  throw new Error(`Timed out waiting for port ${port}.`);
}

async function approveAndInvoke(params: {
  caseId: string;
  env: NodeJS.ProcessEnv;
  gateway: ReturnType<typeof runtime>;
  gatewayToken: string;
  nodeChild: ChildProcess;
  startNode: () => ChildProcess;
}) {
  const url = `ws://127.0.0.1:${GATEWAY_PORT}`;
  const deadline = Date.now() + 60_000;
  let deviceId = "";
  let nodeChild = params.nodeChild;
  const matchesNode = (entry: unknown) =>
    isRecord(entry) &&
    entry.displayName === params.caseId &&
    (entry.role === "node" || (Array.isArray(entry.roles) && entry.roles.includes("node")));
  while (Date.now() < deadline) {
    if (nodeChild.exitCode !== null) {
      throw new Error("Node exited before invocation.");
    }
    if (!deviceId) {
      const devices = await cliJson(
        params.gateway.cli,
        gatewayCliArgs(["devices", "list"], url, params.gatewayToken),
        params.env,
      );
      const pendingDevices =
        isRecord(devices) && Array.isArray(devices.pending)
          ? devices.pending.filter(matchesNode)
          : [];
      const pairedDevices =
        isRecord(devices) && Array.isArray(devices.paired)
          ? devices.paired.filter(matchesNode)
          : [];
      if (pendingDevices.length > 1 || pairedDevices.length > 1) {
        throw new Error(`Multiple device pairings matched ${params.caseId}.`);
      }
      const device = pendingDevices[0] ?? pairedDevices[0];
      if (isRecord(device) && typeof device.deviceId === "string") {
        deviceId = device.deviceId;
        if (typeof device.requestId === "string") {
          const approved = await cliJson(
            params.gateway.cli,
            gatewayCliArgs(["devices", "approve", device.requestId], url, params.gatewayToken),
            params.env,
          );
          if (!approved) {
            throw new Error(`Device pairing approval failed for ${params.caseId}.`);
          }
          await stopChild(nodeChild);
          nodeChild = params.startNode();
          continue;
        }
      }
    }
    const pending = await cliJson(
      params.gateway.cli,
      gatewayCliArgs(["nodes", "pending"], url, params.gatewayToken),
      params.env,
    );
    if (Array.isArray(pending)) {
      const requests = pending.filter(
        (entry) =>
          isRecord(entry) &&
          (entry.nodeId === deviceId || entry.nodeId === params.caseId) &&
          entry.displayName === params.caseId,
      );
      if (requests.length > 1) {
        throw new Error(`Multiple pending requests matched ${params.caseId}.`);
      }
      const requestId = requests[0]?.requestId;
      if (typeof requestId === "string") {
        await cliJson(
          params.gateway.cli,
          gatewayCliArgs(["nodes", "approve", requestId], url, params.gatewayToken),
          params.env,
        );
      }
    }
    const result = await cliJson(
      params.gateway.cli,
      gatewayCliArgs(
        [
          "nodes",
          "invoke",
          "--node",
          params.caseId,
          "--command",
          "system.which",
          "--params",
          JSON.stringify({ bins: ["node"] }),
        ],
        url,
        params.gatewayToken,
      ),
      params.env,
    );
    if (isRecord(result) && result.ok === true && result.command === "system.which") {
      const payload = isRecord(result.payload) ? result.payload : {};
      const bins = isRecord(payload.bins) ? payload.bins : {};
      if (typeof bins.node === "string") {
        return {
          method: "node.invoke",
          command: "system.which",
          params: { bins: ["node"] },
          ok: true,
          result: { bins: { node: bins.node } },
        };
      }
    }
    await delay(250);
  }
  throw new Error(`Timed out invoking ${params.caseId}.`);
}

function gatewayCliArgs(args: string[], url: string, token: string) {
  return [...args, "--json", "--url", url, "--token", token];
}

async function stopChild(child: ChildProcess) {
  if (child.exitCode === null) {
    child.kill("SIGTERM");
  }
  await waitForExit(child);
}

async function cliJson(command: string, args: string[], env: NodeJS.ProcessEnv) {
  const child = spawn(command, args, {
    env,
    stdio: ["ignore", "pipe", "pipe"],
    uid: CANDIDATE_UID,
    gid: CANDIDATE_GID,
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let capturedBytes = 0;
  let exceededLimit = false;
  const capture = (target: Buffer[]) => (chunk: unknown) => {
    const bytes = Buffer.from(chunk as Uint8Array);
    const remaining = CLI_OUTPUT_LIMIT_BYTES - capturedBytes;
    if (remaining > 0) {
      target.push(bytes.subarray(0, remaining));
      capturedBytes += Math.min(bytes.length, remaining);
    }
    if (bytes.length > remaining) {
      exceededLimit = true;
      child.kill("SIGKILL");
    }
  };
  child.stdout.on("data", capture(stdout));
  child.stderr.on("data", capture(stderr));
  const status = await waitForExit(child);
  if (exceededLimit) {
    throw new Error(`CLI output exceeded ${CLI_OUTPUT_LIMIT_BYTES} bytes.`);
  }
  if (status !== 0) {
    return null;
  }
  const text = Buffer.concat(stdout).toString("utf8").trim();
  return text ? (JSON.parse(text) as unknown) : null;
}

async function runDisjointClient(
  packageRoot: string,
  gatewayToken: string,
  children: Set<ChildProcess>,
) {
  const runtimeUrl = pathToFileURL(
    join(packageRoot, "dist", "plugin-sdk", "gateway-runtime.js"),
  ).href;
  const scriptPath = "/tmp/disjoint-client.mjs";
  writeFileSync(
    scriptPath,
    `
const { GatewayClient } = await import(${JSON.stringify(runtimeUrl)});
const timeout = setTimeout(() => process.exit(1), 15000);
const client = new GatewayClient({
  url: "ws://127.0.0.1:${OBSERVER_PORT}", token: ${JSON.stringify(gatewayToken)},
  clientName: "node-host", clientVersion: "gateway-node-compat-disjoint",
  platform: "linux", mode: "node", role: "node", scopes: [], caps: [],
  commands: ["system.which"], minProtocol: 1, maxProtocol: 2,
  onConnectError: () => { clearTimeout(timeout); client.stop(); process.exit(0); },
  onHelloOk: () => process.exit(1),
});
client.start();
`,
    { encoding: "utf8", mode: 0o644 },
  );
  try {
    const child = start(
      process.execPath,
      [scriptPath],
      runtimeEnv("disjoint", "", gatewayToken),
      children,
    );
    if ((await waitForExit(child)) !== 0) {
      throw new Error("Disjoint client did not receive a protocol mismatch.");
    }
  } finally {
    rmSync(scriptPath, { force: true });
  }
}

async function startObserver(upstreamUrl: string) {
  const server = new WebSocketServer({ host: "127.0.0.1", port: OBSERVER_PORT });
  let observation: Observation | undefined;
  let inconsistent = false;
  server.on("connection", (downstream) => {
    const upstream = new WebSocket(upstreamUrl);
    const pending: Array<{ data: RawData; isBinary: boolean }> = [];
    let connectId = "";
    downstream.on("message", (data, isBinary) => {
      const frame = parseFrame(data);
      const connect = isRecord(frame.params) ? frame.params : {};
      const client = isRecord(connect.client) ? connect.client : {};
      if (
        frame.method === "connect" &&
        typeof frame.id === "string" &&
        Number.isSafeInteger(connect.minProtocol) &&
        Number.isSafeInteger(connect.maxProtocol) &&
        typeof connect.role === "string" &&
        typeof client.id === "string" &&
        typeof client.mode === "string" &&
        typeof client.platform === "string"
      ) {
        const next: Observation = {
          clientMin: connect.minProtocol as number,
          clientMax: connect.maxProtocol as number,
          helloProtocol: null,
          identity: {
            clientId: client.id,
            mode: client.mode,
            platform: client.platform,
            role: connect.role,
          },
          protocolError: null,
        };
        inconsistent ||= Boolean(
          observation && !isDeepStrictEqual(observation.identity, next.identity),
        );
        observation = next;
        connectId = frame.id;
      }
      if (upstream.readyState === WebSocket.OPEN) {
        upstream.send(data, { binary: isBinary });
      } else {
        pending.push({ data, isBinary });
      }
    });
    upstream.on("open", () => {
      for (const message of pending.splice(0)) {
        upstream.send(message.data, { binary: message.isBinary });
      }
    });
    upstream.on("message", (data, isBinary) => {
      const frame = parseFrame(data);
      if (observation && frame.id === connectId) {
        const payload = isRecord(frame.payload) ? frame.payload : {};
        if (payload.type === "hello-ok" && Number.isSafeInteger(payload.protocol)) {
          observation.helloProtocol = payload.protocol as number;
          observation.protocolError = null;
        } else if (Object.hasOwn(frame, "error")) {
          observation.protocolError = frame.error;
          observation.helloProtocol = null;
        }
      }
      if (downstream.readyState === WebSocket.OPEN) {
        downstream.send(data, { binary: isBinary });
      }
    });
    upstream.on("close", (code, reason) => downstream.close(code, reason.toString()));
    upstream.on("error", () => downstream.terminate());
    downstream.on("close", () => upstream.close());
  });
  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.once("listening", resolvePromise);
    server.once("error", rejectPromise);
  });
  return {
    read() {
      if (!observation || inconsistent) {
        throw new Error("Observer did not capture one consistent node connection.");
      }
      return observation;
    },
    close: async () => {
      for (const socket of server.clients) {
        socket.terminate();
      }
      await new Promise<void>((resolvePromise) => {
        server.close(resolvePromise);
      });
    },
  };
}

export function normalizeMismatch(observation: Observation, legacyVersion?: string) {
  if (observation.clientMin !== 1 || observation.clientMax !== 2) {
    throw new Error("Disjoint client did not advertise exact protocol range 1..2.");
  }
  const error = isRecord(observation.protocolError) ? observation.protocolError : {};
  const outer = isRecord(error.details) ? error.details : {};
  const details = Object.hasOwn(outer, "code")
    ? outer
    : isRecord(outer.details)
      ? outer.details
      : {};
  if (
    legacyVersion === "2026.5.7" &&
    Object.keys(outer).length === 1 &&
    outer.expectedProtocol === 3
  ) {
    return {
      code: "PROTOCOL_MISMATCH",
      clientMinProtocol: 1,
      clientMaxProtocol: 2,
      expectedProtocol: outer.expectedProtocol,
    };
  }
  if (
    details.code !== "PROTOCOL_MISMATCH" ||
    details.clientMinProtocol !== 1 ||
    details.clientMaxProtocol !== 2 ||
    !Number.isSafeInteger(details.expectedProtocol) ||
    Number(details.expectedProtocol) <= observation.clientMax
  ) {
    throw new Error("Gateway did not return matching structured PROTOCOL_MISMATCH.");
  }
  return details;
}

export function validateObservedIdentity(observation: Observation) {
  if (
    observation.identity.role !== "node" ||
    observation.identity.mode !== "node" ||
    observation.identity.clientId !== "node-host" ||
    observation.identity.platform !== "linux"
  ) {
    throw new Error("Observed connect identity is not a Linux node-host session.");
  }
  return observation;
}

function parseFrame(data: unknown) {
  try {
    const text = Buffer.isBuffer(data)
      ? data.toString("utf8")
      : Array.isArray(data)
        ? Buffer.concat(data.map((part) => Buffer.from(part))).toString("utf8")
        : Buffer.from(data as Uint8Array).toString("utf8");
    const value: unknown = JSON.parse(text);
    return isRecord(value) ? value : {};
  } catch {
    return {};
  }
}

// This script runs as a standalone read-only mount outside workspace package resolution.
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function waitForExit(child: ChildProcess) {
  if (child.exitCode !== null) {
    return Promise.resolve(child.exitCode);
  }
  return new Promise<number>((resolvePromise) => {
    child.once("close", (status) => resolvePromise(status ?? 1));
    child.once("error", () => resolvePromise(1));
  });
}
