import Foundation
import OpenClawKit
import Testing
@testable import OpenClaw

struct MacNodeModeCoordinatorTests {
    @Test func `remote mode does not advertise browser proxy`() {
        let caps = MacNodeModeCoordinator.resolvedCaps(
            browserControlEnabled: true,
            cameraEnabled: false,
            locationMode: .off,
            connectionMode: .remote)
        let commands = MacNodeModeCoordinator.resolvedCommands(caps: caps)

        #expect(!caps.contains(OpenClawCapability.browser.rawValue))
        #expect(caps.contains(OpenClawCapability.mcpHost.rawValue))
        #expect(!commands.contains(OpenClawBrowserCommand.proxy.rawValue))
        #expect(commands.contains(OpenClawCanvasCommand.present.rawValue))
        #expect(commands.contains(OpenClawSystemCommand.notify.rawValue))
    }

    @Test func `local mode advertises browser proxy when enabled`() {
        let caps = MacNodeModeCoordinator.resolvedCaps(
            browserControlEnabled: true,
            cameraEnabled: false,
            locationMode: .off,
            connectionMode: .local)
        let commands = MacNodeModeCoordinator.resolvedCommands(caps: caps)

        #expect(caps.contains(OpenClawCapability.browser.rawValue))
        #expect(caps.contains(OpenClawCapability.mcpHost.rawValue))
        #expect(commands.contains(OpenClawBrowserCommand.proxy.rawValue))
    }

    @Test func `computer use mcp descriptor reports missing permissions`() {
        let descriptors = MacNodeModeCoordinator.resolvedMcpServers(permissions: [
            "accessibility": true,
            "screenRecording": false,
        ])

        #expect(descriptors.count == 1)
        #expect(descriptors.first?.id == "computer-use")
        #expect(descriptors.first?.status == "missing_permissions")
        #expect(descriptors.first?.requiredpermissions == ["accessibility", "screenRecording"])
    }
}
