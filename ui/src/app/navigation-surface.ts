import { html, nothing } from "lit";
import type { ApplicationContext } from "./context.ts";

export function navigationSurfaceIsHidden(params: {
  navCollapsed: boolean;
  navDrawerOpen: boolean;
  mobileNavLayout: boolean;
}): boolean {
  return params.mobileNavLayout ? !params.navDrawerOpen : params.navCollapsed;
}

export function renderFloatingUpdateCard(params: {
  navigationSurfaceHidden: boolean;
  onboarding: boolean;
  updateAvailable: ApplicationContext["overlays"]["snapshot"]["updateAvailable"];
  updateSchedule?: ApplicationContext["overlays"]["snapshot"]["updateSchedule"];
  heldUpdateCampaignId?: string | null;
  updateRunning: boolean;
  canUpdate?: boolean;
  canHoldUpdate?: boolean;
  onUpdate: () => void;
  onHoldUpdate?: () => Promise<boolean>;
}) {
  if (!params.navigationSurfaceHidden || params.onboarding) {
    return nothing;
  }
  return html`<openclaw-sidebar-update-card
    class="sidebar-update-card--floating"
    .updateAvailable=${params.updateAvailable}
    .updateSchedule=${params.updateSchedule ?? null}
    .heldUpdateCampaignId=${params.heldUpdateCampaignId ?? null}
    .updateRunning=${params.updateRunning}
    .canUpdate=${params.canUpdate ?? false}
    .canHoldUpdate=${params.canHoldUpdate ?? false}
    .onUpdate=${params.onUpdate}
    .onHoldUpdate=${params.onHoldUpdate ?? (async () => false)}
  ></openclaw-sidebar-update-card>`;
}
