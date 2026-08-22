import { t } from "../i18n/index.ts";
import { registerSessionsManagementEnglish } from "../i18n/locales/en-sessions-management.ts";
import { renderHubTabs, type HubTabOption } from "./hub-tabs.ts";

registerSessionsManagementEnglish();

export type SessionsHubTab = "sessions" | "operations" | "worktrees";

type SessionsHubTabsProps = {
  active: SessionsHubTab;
  onSelect: (tab: SessionsHubTab) => void;
};

function hubTabs(): ReadonlyArray<HubTabOption<SessionsHubTab>> {
  return [
    { value: "sessions", label: t("tabs.sessions") },
    { value: "operations", label: t("sessionsView.operations") },
    { value: "worktrees", label: t("tabs.worktrees") },
  ];
}

/** Every route marks its main content with id="sessions-hub-panel". */
export function renderSessionsHubTabs(props: SessionsHubTabsProps) {
  return renderHubTabs({
    id: "sessions",
    active: props.active,
    tabs: hubTabs(),
    ariaLabel: t("sessionsPage.hubTablistLabel"),
    panelId: "sessions-hub-panel",
    onSelect: props.onSelect,
  });
}
