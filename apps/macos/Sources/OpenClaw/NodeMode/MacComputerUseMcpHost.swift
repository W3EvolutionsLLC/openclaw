import Foundation
import OpenClawIPC
import OpenClawKit
import OpenClawProtocol
import OSLog

private let computerUseServerId = "computer-use"
private let computerUseRequiredPermissions = [Capability.accessibility.rawValue, Capability.screenRecording.rawValue]

private struct MacMcpLaunchConfig: Sendable {
    var command: URL
    var args: [String]
    var cwd: URL?
    var source: String
}

private struct CodexMcpManifest: Decodable {
    struct Server: Decodable {
        var command: String
        var args: [String]?
        var cwd: String?
    }

    var mcpServers: [String: Server]
}

private final class ActiveMacMcpSession: @unchecked Sendable {
    let sessionId: String
    let nodeId: String
    let process: Process
    let input: Pipe
    var nextSeq = 0
    var closeRequested = false

    init(sessionId: String, nodeId: String, process: Process, input: Pipe) {
        self.sessionId = sessionId
        self.nodeId = nodeId
        self.process = process
        self.input = input
    }
}

actor MacComputerUseMcpHost {
    private let logger = Logger(subsystem: "ai.openclaw", category: "mac-mcp")
    private var sessions: [String: ActiveMacMcpSession] = [:]

    nonisolated static func computerUseDescriptor(permissions: [String: Bool]) -> NodeMcpServerDescriptor {
        let hasRequiredPermissions = computerUseRequiredPermissions.allSatisfy { permissions[$0] == true }
        let launch = Self.resolveComputerUseLaunchConfig()
        let status: String = if !hasRequiredPermissions {
            "missing_permissions"
        } else if launch == nil {
            "missing_backend"
        } else {
            "ready"
        }
        var metadata: [String: AnyCodable] = [:]
        if let launch {
            metadata["source"] = AnyCodable(launch.source)
            metadata["command"] = AnyCodable(launch.command.lastPathComponent)
        }
        return NodeMcpServerDescriptor(
            id: computerUseServerId,
            displayname: "Computer Use",
            provider: "codex",
            transport: "stdio",
            source: launch?.source ?? "codex-bundled",
            status: status,
            requiredpermissions: computerUseRequiredPermissions,
            metadata: metadata.isEmpty ? nil : metadata)
    }

    func open(_ event: NodeMcpSessionOpenEvent, gateway: GatewayNodeSession) async {
        guard event.serverid == computerUseServerId else {
            await gateway.sendMcpSessionOpenResult(Self.openResult(
                event: event,
                ok: false,
                errorCode: "UNKNOWN_SERVER",
                message: "unknown MCP server"))
            return
        }
        guard let launch = Self.resolveComputerUseLaunchConfig() else {
            await gateway.sendMcpSessionOpenResult(Self.openResult(
                event: event,
                ok: false,
                errorCode: "MISSING_BACKEND",
                message: "Codex Computer Use MCP backend is not installed"))
            return
        }

        let process = Process()
        process.executableURL = launch.command
        process.arguments = launch.args
        process.currentDirectoryURL = launch.cwd

        let stdin = Pipe()
        let stdout = Pipe()
        let stderr = Pipe()
        process.standardInput = stdin
        process.standardOutput = stdout
        process.standardError = stderr

        let active = ActiveMacMcpSession(
            sessionId: event.sessionid,
            nodeId: event.nodeid,
            process: process,
            input: stdin)
        self.sessions[event.sessionid] = active

        stdout.fileHandleForReading.readabilityHandler = { [weak self] fileHandle in
            let data = fileHandle.availableData
            guard !data.isEmpty else { return }
            Task { await self?.emitOutput(sessionId: event.sessionid, stream: "stdout", data: data, gateway: gateway) }
        }
        stderr.fileHandleForReading.readabilityHandler = { [weak self] fileHandle in
            let data = fileHandle.availableData
            guard !data.isEmpty else { return }
            Task { await self?.emitOutput(sessionId: event.sessionid, stream: "stderr", data: data, gateway: gateway) }
        }
        process.terminationHandler = { [weak self] process in
            Task { await self?.handleTermination(sessionId: event.sessionid, process: process, gateway: gateway) }
        }

        do {
            try process.run()
        } catch {
            stdout.fileHandleForReading.readabilityHandler = nil
            stderr.fileHandleForReading.readabilityHandler = nil
            self.sessions[event.sessionid] = nil
            await gateway.sendMcpSessionOpenResult(Self.openResult(
                event: event,
                ok: false,
                errorCode: "SPAWN_FAILED",
                message: error.localizedDescription))
            return
        }

        await gateway.sendMcpSessionOpenResult(NodeMcpSessionOpenResultParams(
            sessionid: event.sessionid,
            nodeid: event.nodeid,
            serverid: event.serverid,
            ok: true,
            pid: Int(process.processIdentifier),
            error: nil))
        self.logger.info("computer-use MCP session opened pid=\(process.processIdentifier, privacy: .public)")
    }

    func input(_ event: NodeMcpSessionInputEvent) async {
        guard let active = self.sessions[event.sessionid], active.nodeId == event.nodeid else {
            return
        }
        guard let data = Data(base64Encoded: event.database64) else {
            return
        }
        active.input.fileHandleForWriting.write(data)
    }

    func close(_ event: NodeMcpSessionCloseEvent) async {
        guard let active = self.sessions[event.sessionid], active.nodeId == event.nodeid else {
            return
        }
        active.closeRequested = true
        try? active.input.fileHandleForWriting.close()
        if active.process.isRunning {
            active.process.terminate()
        }
    }

    private func emitOutput(sessionId: String, stream: String, data: Data, gateway: GatewayNodeSession) async {
        guard let active = self.sessions[sessionId] else { return }
        let seq = active.nextSeq
        active.nextSeq += 1
        await gateway.sendMcpSessionOutput(NodeMcpSessionOutputParams(
            sessionid: active.sessionId,
            nodeid: active.nodeId,
            seq: seq,
            stream: stream,
            database64: data.base64EncodedString()))
    }

    private func handleTermination(sessionId: String, process: Process, gateway: GatewayNodeSession) async {
        guard let active = self.sessions.removeValue(forKey: sessionId) else { return }
        let ok = active.closeRequested || process.terminationStatus == 0
        await gateway.sendMcpSessionClosed(NodeMcpSessionClosedParams(
            sessionid: active.sessionId,
            nodeid: active.nodeId,
            ok: ok,
            exitcode: AnyCodable(Int(process.terminationStatus)),
            signal: process.terminationReason == .uncaughtSignal
                ? AnyCodable(Int(process.terminationStatus))
                : nil,
            error: ok
                ? nil
                : [
                    "code": AnyCodable("PROCESS_EXITED"),
                    "message": AnyCodable("MCP backend exited with status \(process.terminationStatus)"),
                ]))
    }

    private static func openResult(
        event: NodeMcpSessionOpenEvent,
        ok: Bool,
        errorCode: String,
        message: String) -> NodeMcpSessionOpenResultParams
    {
        NodeMcpSessionOpenResultParams(
            sessionid: event.sessionid,
            nodeid: event.nodeid,
            serverid: event.serverid,
            ok: ok,
            pid: nil,
            error: [
                "code": AnyCodable(errorCode),
                "message": AnyCodable(message),
            ])
    }

    private nonisolated static func resolveComputerUseLaunchConfig() -> MacMcpLaunchConfig? {
        let env = ProcessInfo.processInfo.environment
        if let rawCommand = env["OPENCLAW_COMPUTER_USE_MCP_COMMAND"]?.trimmingCharacters(in: .whitespacesAndNewlines),
           !rawCommand.isEmpty
        {
            let command = URL(fileURLWithPath: NSString(string: rawCommand).expandingTildeInPath)
            return MacMcpLaunchConfig(
                command: command,
                args: Self.parseEnvArgs(env["OPENCLAW_COMPUTER_USE_MCP_ARGS"]) ?? ["mcp"],
                cwd: nil,
                source: "env")
        }

        let pluginDir = URL(fileURLWithPath: "/Applications/Codex.app/Contents/Resources/plugins/openai-bundled/plugins/computer-use")
        let manifestURL = pluginDir.appendingPathComponent(".mcp.json")
        guard
            let data = try? Data(contentsOf: manifestURL),
            let manifest = try? JSONDecoder().decode(CodexMcpManifest.self, from: data),
            let server = manifest.mcpServers[computerUseServerId]
        else {
            return nil
        }
        let cwd = resolvePath(server.cwd ?? ".", relativeTo: pluginDir)
        let command = resolvePath(server.command, relativeTo: cwd)
        return MacMcpLaunchConfig(
            command: command,
            args: server.args ?? [],
            cwd: cwd,
            source: "codex-bundled")
    }

    private nonisolated static func parseEnvArgs(_ raw: String?) -> [String]? {
        guard let raw, let data = raw.data(using: .utf8) else { return nil }
        return (try? JSONSerialization.jsonObject(with: data)) as? [String]
    }

    private nonisolated static func resolvePath(_ raw: String, relativeTo base: URL) -> URL {
        let expanded = NSString(string: raw).expandingTildeInPath
        if expanded.hasPrefix("/") {
            return URL(fileURLWithPath: expanded)
        }
        return base.appendingPathComponent(expanded)
    }
}
