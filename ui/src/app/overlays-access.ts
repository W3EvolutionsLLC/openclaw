import type { GatewayBrowserClient } from "../api/gateway.ts";
import { refreshPendingApprovalQueue, type ExecApprovalPromptState } from "./exec-approval.ts";
import type { ApplicationGateway } from "./gateway.ts";
import { readGatewayOperatorAccess } from "./operator-access.ts";

type OverlayOperatorAccess = ReturnType<typeof readGatewayOperatorAccess>;

export function readOverlayOperatorAccessTransition(
  previous: OverlayOperatorAccess,
  snapshot: ApplicationGateway["snapshot"],
) {
  const access = readGatewayOperatorAccess(snapshot);
  return {
    access,
    reviewChanged: previous.canReviewApprovals !== access.canReviewApprovals,
    grantChanged: previous.canGrantApprovals !== access.canGrantApprovals,
    grantRevoked: previous.canGrantApprovals && !access.canGrantApprovals,
    adminRevoked: previous.canAdmin && !access.canAdmin,
    pairingChanged: previous.canPair !== access.canPair,
    pairingSetupRevoked:
      (previous.canAdmin || previous.canPair) && !(access.canAdmin || access.canPair),
  };
}

export function createOverlayApprovalRefresher(params: {
  gateway: ApplicationGateway;
  state: ExecApprovalPromptState;
  getConnectedEpoch: () => number;
  getReviewGeneration: () => number;
  canReview: () => boolean;
  isCurrentClient: (client: GatewayBrowserClient) => boolean;
  isDisposed: () => boolean;
  publish: () => void;
}) {
  return async (
    client: GatewayBrowserClient,
    epoch = params.getConnectedEpoch(),
    reviewGeneration = params.getReviewGeneration(),
  ) => {
    if (
      !params.canReview() ||
      reviewGeneration !== params.getReviewGeneration() ||
      !readGatewayOperatorAccess(params.gateway.snapshot).canReviewApprovals
    ) {
      return;
    }
    const applied = await refreshPendingApprovalQueue(params.state, {
      isCurrentClient: (requestClient) =>
        requestClient === client &&
        epoch === params.getConnectedEpoch() &&
        reviewGeneration === params.getReviewGeneration() &&
        params.canReview() &&
        readGatewayOperatorAccess(params.gateway.snapshot).canReviewApprovals &&
        params.isCurrentClient(client),
    });
    if (applied && !params.isDisposed()) {
      params.publish();
    }
  };
}
