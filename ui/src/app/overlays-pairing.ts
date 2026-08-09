// Application-owned pairing overlay: the wizard lifecycle, its pending-device
// counter, and the Gateway target it belongs to.
import {
  createPairingWizard,
  type PairingConfigWriter,
  type PairingWizardActions,
  type PairingWizardDeps,
  type PairingWizardSnapshot,
} from "../lib/pairing/wizard.ts";
import type { ApplicationGateway } from "./gateway.ts";
import { readGatewayOperatorAccess } from "./operator-access.ts";

// Without the app's runtime config capability the browser genuinely cannot
// write config, so the LAN step reports that instead of pretending to apply.
const UNAVAILABLE_PAIRING_CONFIG_WRITER: PairingConfigWriter = {
  refresh: async () => {},
  readHash: () => null,
  patch: async () => false,
  readError: () => "Configuration writes are unavailable on this connection.",
};

export const EMPTY_PAIRING_WIZARD_SNAPSHOT: PairingWizardSnapshot = {
  open: false,
  access: "full",
  step: { kind: "inspecting" },
  notice: null,
};

function canAccessDevicePairing(snapshot: ApplicationGateway["snapshot"]): boolean {
  const access = readGatewayOperatorAccess(snapshot);
  return access.canAdmin || access.canPair;
}

export function createOverlayPairing(params: {
  gateway: ApplicationGateway;
  config?: PairingConfigWriter;
  probe?: PairingWizardDeps["probe"];
  isDisposed: () => boolean;
  publish: () => void;
}) {
  const { gateway } = params;
  let pendingCount = 0;
  let pendingGeneration = 0;
  let gatewayUrl = gateway.connection.gatewayUrl;
  const wizard = createPairingWizard({
    config: params.config ?? UNAVAILABLE_PAIRING_CONFIG_WRITER,
    onChange: params.publish,
    ...(params.probe ? { probe: params.probe } : {}),
  });
  wizard.setConnection({
    client: gateway.snapshot.client,
    connected: gateway.snapshot.phase === "connected",
  });

  const invalidatePending = (options: { clear?: boolean } = {}) => {
    pendingGeneration += 1;
    if (options.clear) {
      pendingCount = 0;
    }
  };

  const refreshPending = async () => {
    const client = gateway.snapshot.client;
    if (
      !client ||
      gateway.snapshot.phase !== "connected" ||
      params.isDisposed() ||
      !wizard.snapshot.open ||
      !canAccessDevicePairing(gateway.snapshot)
    ) {
      return;
    }
    const requestGeneration = ++pendingGeneration;
    let result: { pending?: unknown };
    try {
      result = await client.request<{ pending?: unknown }>("device.pair.list", {});
    } catch {
      return;
    }
    if (
      params.isDisposed() ||
      requestGeneration !== pendingGeneration ||
      gateway.snapshot.client !== client ||
      gateway.snapshot.phase !== "connected" ||
      !wizard.snapshot.open ||
      !canAccessDevicePairing(gateway.snapshot)
    ) {
      return;
    }
    pendingCount = Array.isArray(result.pending) ? result.pending.length : 0;
    params.publish();
  };

  const actions: PairingWizardActions = {
    setAccess: (access) => wizard.setAccess(access),
    chooseRoute: async (route) => await wizard.chooseRoute(route),
    setPublicUrl: (value) => wizard.setPublicUrl(value),
    submitPublicUrl: async () => await wizard.submitPublicUrl(),
    confirmLan: async () => await wizard.confirmLan(),
    back: async () => await wizard.back(),
  };

  return {
    actions,
    get snapshot(): PairingWizardSnapshot {
      return wizard.snapshot;
    },
    get pendingCount(): number {
      return pendingCount;
    },
    invalidatePending,
    refreshPending,
    close() {
      wizard.close();
    },
    async open() {
      const access = readGatewayOperatorAccess(gateway.snapshot);
      if (params.isDisposed() || !canAccessDevicePairing(gateway.snapshot)) {
        return;
      }
      pendingCount = 0;
      const opening = wizard.open({ canAdmin: access.canAdmin });
      // Pairing-list latency must not hold the wizard behind a loading state.
      void refreshPending();
      await opening;
    },
    /**
     * Keeps the wizard across the disconnect a `gateway.*` change is expected to
     * cause, but drops it when the app points at a different Gateway: a retained
     * plan, its captured prior config leaves, and any staged inverse write all
     * belong to the previous host.
     */
    syncConnection(next: { client: ApplicationGateway["snapshot"]["client"]; connected: boolean }) {
      if (gateway.connection.gatewayUrl !== gatewayUrl) {
        gatewayUrl = gateway.connection.gatewayUrl;
        wizard.close();
      }
      wizard.setConnection(next);
    },
  };
}
