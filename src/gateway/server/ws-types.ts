import type { WebSocket } from "ws";
import type { ConnectParams } from "../protocol/index.js";
import type { PairingLocalityKind } from "./ws-connection/handshake-auth-helpers.js";

export type GatewayWsClient = {
  socket: WebSocket;
  connect: ConnectParams;
  connId: string;
  isDeviceTokenAuth?: boolean;
  usesSharedGatewayAuth: boolean;
  pairingLocality?: PairingLocalityKind;
  sharedGatewaySessionGeneration?: string;
  presenceKey?: string;
  clientIp?: string;
  canvasHostUrl?: string;
  canvasCapability?: string;
  canvasCapabilityExpiresAtMs?: number;
};
